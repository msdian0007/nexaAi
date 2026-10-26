import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";
import { AnswerView } from "../chat/ChatPage";
import {
  parseDocument,
  PROCESSING_LABELS,
  processingState,
} from "../documents/document.types";
import type { DocumentStatus } from "../documents/document.types";
import {
  parseAgentResult,
  parseEnvelope,
  parseExecutions,
  parseProposal,
} from "./agent.types";
import type { AgentResult, Execution } from "./agent.types";

const tools: Record<string, string> = {
  knowledge_answer: "Knowledge answer",
  document_counts: "Saved document counts",
  retry_document: "Document retry",
};
const proposalLabels = {
  PENDING: "Awaiting confirmation",
  CLAIMED: "In progress or interrupted",
  ACCEPTED: "Queue submission accepted",
  REJECTED: "Rejected; review a new proposal",
  UNCERTAIN: "Submission unconfirmed",
  CANCELLED: "Cancelled",
};
function Executions({
  revision,
  review,
  disabled,
}: {
  revision: number;
  review: (id: string) => void;
  disabled: boolean;
}) {
  const { request } = useAuth();
  const [records, setRecords] = useState<Execution[]>([]);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void request("/agents/executions", { signal: controller.signal })
      .then((data) => {
        const parsed = parseExecutions(data);
        if (!controller.signal.aborted) {
          setRecords(parsed);
          setError("");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load execution records. Refresh to try again.");
      });
    return () => controller.abort();
  }, [request, revision, reload]);
  return (
    <section className="agent-executions" aria-labelledby="execution-heading">
      <h2 id="execution-heading">Recent executions</h2>
      <p>
        Your latest 20 executions in this organization. Records contain
        operation metadata, not saved questions or answers.
      </p>
      <button
        className="secondary-button"
        disabled={disabled}
        onClick={() => setReload((n) => n + 1)}
      >
        Refresh executions
      </button>
      {error && <p role="alert">{error}</p>}
      <ul>
        {records.map((r) => (
          <li key={r.id}>
            <strong>
              {r.operation === "REQUEST"
                ? "Request"
                : r.operation === "CONFIRM"
                  ? "Confirmation"
                  : "Cancellation"}
            </strong>
            {" · "}
            {r.operation === "REQUEST" && r.tool === "retry_document"
              ? "Retry proposal"
              : r.tool
                ? tools[r.tool]
                : "Selection"}
            {" · "}
            {r.outcome === "STARTED"
              ? "Started or interrupted"
              : r.outcome.toLowerCase()}
            <small>
              {new Date(r.startedAt).toLocaleString()}
              {r.durationMs !== null && ` · ${r.durationMs} ms`}
            </small>
            {r.proposalId && (
              <button
                className="text-button"
                disabled={disabled}
                onClick={() => review(r.proposalId!)}
              >
                Review proposal
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function AgentPage() {
  const { request, session } = useAuth();
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<AgentResult | null>(null);
  const [executionId, setExecutionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [checked, setChecked] = useState(true);
  const [expired, setExpired] = useState(false);
  const [document, setDocument] = useState<DocumentStatus | null>(null);
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  // Keep uncertain attempts blocked even if the user views another result and
  // later reopens this proposal from execution records in the same workspace.
  const attemptedProposals = useRef(new Set<string>());
  const heading = useRef<HTMLHeadingElement>(null);
  const errorHeading = useRef<HTMLParagraphElement>(null);
  const proposal = result?.kind === "proposal" ? result.proposal : null;
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (result) heading.current?.focus();
  }, [result]);
  useEffect(() => {
    if (error) errorHeading.current?.focus();
  }, [error]);
  useEffect(() => {
    if (!proposal) return;
    const timer = setInterval(
      () => setExpired(Date.parse(proposal.expiresAt) <= Date.now()),
      1000,
    );
    return () => clearInterval(timer);
  }, [proposal]);

  async function perform(
    work: (signal: AbortSignal) => Promise<void>,
    mutation = false,
  ) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work(controller.signal);
    } catch (failure) {
      if (controller.signal.aborted) return;
      setError(
        failure instanceof ApiError && ((failure.status === 429 && failure.code === "RATE_LIMITED") || (failure.status === 503 && failure.code === "USAGE_UNAVAILABLE"))
          ? failure.message
          : mutation
          ? "Could not confirm this action. Refresh proposal and document status before making a new request. This proposal will not be submitted again."
          : failure instanceof ApiError && failure.status === 403
            ? "Your access has changed. Check your current organization membership."
            : "The agent response could not be loaded. Your request is kept; no request is retried automatically.",
      );
    } finally {
      if (active.current === controller) active.current = null;
      if (!controller.signal.aborted) {
        setBusy(false);
        setRevision((n) => n + 1);
      }
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || trimmed.length > 1000 || blocked) return;
    await perform(async (signal) => {
      // This page shows one request result at a time. Do not leave an earlier
      // answer visible as though it answered a newer request that failed.
      setResult(null);
      setExecutionId("");
      setDocument(null);
      const data = await request("/agents/requests", {
        method: "POST",
        body: { message: trimmed },
        signal,
      });
      const parsed = parseAgentResult(data, trimmed);
      if (signal.aborted) return;
      setResult(parsed.result);
      setExecutionId(parsed.executionId);
      setMessage("");
      setAttempted(
        parsed.result.kind === "proposal" &&
          attemptedProposals.current.has(parsed.result.proposal.id),
      );
      setChecked(true);
      setDocument(null);
      setExpired(
        parsed.result.kind === "proposal" &&
          Date.parse(parsed.result.proposal.expiresAt) <= Date.now(),
      );
    });
  }
  async function act(kind: "confirm" | "cancel") {
    if (
      !proposal ||
      busy ||
      attempted ||
      proposal.state !== "PENDING" ||
      expired
    )
      return;
    // A click consumes this panel's permission to submit. Even a timeout or bad
    // response cannot re-enable confirmation; reads are safe to repeat.
    attemptedProposals.current.add(proposal.id);
    setAttempted(true);
    setChecked(false);
    await perform(async (signal) => {
      const response = parseEnvelope(
        await request(`/agents/proposals/${proposal.id}/${kind}`, {
          method: "POST",
          signal,
        }).catch((failure: unknown) => {
          // These explicit receipts prove admission rejected the action. Only
          // that case permits another manual click; lost responses stay blocked.
          if (!signal.aborted && failure instanceof ApiError && ((failure.status === 429 && failure.code === "RATE_LIMITED") || (failure.status === 503 && failure.code === "USAGE_UNAVAILABLE"))) {
            attemptedProposals.current.delete(proposal.id);
            setAttempted(false);
          }
          throw failure;
        }),
      );
      if (kind === "confirm") {
        const data = response.result.data as
          | { documentId?: unknown; state?: unknown }
          | undefined;
        if (
          response.result.tool !== "retry_document" ||
          data?.documentId !== proposal.documentId ||
          data.state !== "accepted"
        )
          throw new Error("Invalid acknowledgement");
      } else {
        const cancelled = parseProposal(response.result);
        if (
          cancelled.id !== proposal.id ||
          cancelled.documentId !== proposal.documentId ||
          cancelled.state !== "CANCELLED"
        )
          throw new Error("Invalid cancellation");
      }
      if (signal.aborted) return;
      setResult({
        kind: "proposal",
        proposal: {
          ...proposal,
          state: kind === "confirm" ? "ACCEPTED" : "CANCELLED",
        },
      });
      setExecutionId(response.executionId);
      setChecked(true);
      setNotice(
        kind === "confirm"
          ? "Retry accepted for background processing. It has not necessarily finished."
          : "Proposal cancelled. No retry was submitted by this cancellation.",
      );
    }, true);
  }
  async function refresh() {
    if (!proposal) return;
    await perform(async (signal) => {
      const receipt = parseProposal(
        await request(`/agents/proposals/${proposal.id}`, { signal }),
      );
      if (
        receipt.id !== proposal.id ||
        receipt.documentId !== proposal.documentId
      )
        throw new Error("Proposal mismatch");
      let next: DocumentStatus | null = null;
      try {
        next = parseDocument(
          await request(`/agents/proposals/${proposal.id}/document-status`, {
            signal,
          }),
        );
        if (next.id !== proposal.documentId)
          throw new Error("Document mismatch");
      } catch (failure) {
        if (!(failure instanceof ApiError && failure.status === 404))
          throw failure;
      }
      if (signal.aborted) return;
      setResult({ kind: "proposal", proposal: receipt });
      setDocument(next);
      setChecked(true);
      setExpired(Date.parse(receipt.expiresAt) <= Date.now());
      setNotice(
        next
          ? "Saved proposal and current document status refreshed. Refreshing does not submit work."
          : "The document is no longer available. Choose another document.",
      );
    });
  }
  async function review(id: string) {
    await perform(async (signal) => {
      const next = parseProposal(
        await request(`/agents/proposals/${id}`, { signal }),
      );
      if (next.id !== id) throw new Error("Proposal mismatch");
      if (signal.aborted) return;
      setAttempted(
        attemptedProposals.current.has(next.id) || next.state !== "PENDING",
      );
      setResult({ kind: "proposal", proposal: next });
      setDocument(null);
      setChecked(true);
      setExecutionId("");
      setExpired(Date.parse(next.expiresAt) <= Date.now());
    });
  }
  const blocked =
    busy ||
    !!(
      proposal &&
      ((proposal.state === "PENDING" && !attempted && !expired) ||
        (attempted && !checked))
    );
  return (
    <section className="workspace agent-page" aria-labelledby="agent-heading">
      <p className="eyebrow">TOOLS FOR YOUR WORKSPACE</p>
      <h1 id="agent-heading">Agent</h1>
      <p>
        Ask about {session?.organization.name}&apos;s documents, count saved
        processing statuses, or review a retry proposal.
      </p>
      <p>
        For a retry, include one document ID from the{" "}
        <Link to="/documents">document library</Link>. Each request is
        independent; include the details it needs.
      </p>
      <form className="question-panel" onSubmit={submit} aria-busy={busy}>
        <label htmlFor="agent-request">Your agent request</label>
        <textarea
          id="agent-request"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          maxLength={1000}
          rows={4}
          disabled={blocked}
          aria-describedby="agent-help"
          required
        />
        <p id="agent-help">
          {message.length}/1,000 characters. Example: How many documents have
          saved FAILED status?
        </p>
        <button
          className="primary-button"
          type="submit"
          disabled={blocked || !message.trim()}
        >
          Run agent
        </button>
      </form>
      {busy && <p role="status">Working on your agent operation...</p>}
      {error && (
        <p className="form-error" ref={errorHeading} tabIndex={-1} role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {result && (
        <section
          className="upload-result agent-result"
          aria-label="Agent result"
        >
          <h2 tabIndex={-1} ref={heading}>
            {result.kind === "knowledge"
              ? "Tool: Knowledge answer"
              : result.kind === "counts"
                ? "Tool: Saved document counts"
                : result.kind === "proposal"
                  ? "Review document retry"
                  : result.kind === "clarification"
                    ? "More details needed"
                    : "Operation unavailable"}
          </h2>
          {executionId && (
            <small>
              Execution ID: <code>{executionId}</code>
            </small>
          )}
          {result.kind === "knowledge" && <AnswerView answer={result.answer} />}
          {result.kind === "counts" && (
            <>
              <p>
                Current saved documents, excluding pending deletions. These are
                database statuses, not live queue states or historical upload
                attempts.
              </p>
              <p>
                <strong>Total documents: {result.counts.total}</strong>
              </p>
              <table>
                <caption>Saved processing statuses</caption>
                <thead>
                  <tr>
                    <th scope="col">Status</th>
                    <th scope="col">Documents</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.counts.byStatus).map(([status, n]) => (
                    <tr key={status}>
                      <th scope="row">{status}</th>
                      <td>{n}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>Read at {new Date(result.counts.asOf).toLocaleString()}</p>
            </>
          )}
          {(result.kind === "clarification" ||
            result.kind === "unsupported") && <p>{result.message}</p>}
          {proposal && (
            <>
              <p>
                Retry <strong>{proposal.documentName}</strong>?
              </p>
              <p>
                Document ID: <code>{proposal.documentId}</code>
              </p>
              <p>
                Expires: {new Date(proposal.expiresAt).toLocaleString()}
                {expired && " — expired"}
              </p>
              <p>
                Proposal state:{" "}
                <strong>{proposalLabels[proposal.state]}</strong>. Confirming
                submits background work; it does not mean processing has
                finished.
              </p>
              <button
                className="primary-button"
                disabled={
                  busy || attempted || expired || proposal.state !== "PENDING"
                }
                onClick={() => void act("confirm")}
              >
                Confirm retry
              </button>{" "}
              <button
                className="secondary-button"
                disabled={
                  busy || attempted || expired || proposal.state !== "PENDING"
                }
                onClick={() => void act("cancel")}
              >
                Cancel proposal
              </button>{" "}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Refresh proposal and document status
              </button>
              {attempted && !checked && (
                <p>
                  Refresh saved status before making a new request. This
                  confirmation will not be repeated.
                </p>
              )}
              {document && (
                <p>
                  Current document status:{" "}
                  <strong>
                    {PROCESSING_LABELS[processingState(document)]}
                  </strong>
                </p>
              )}
              <p>
                <Link to="/documents">Open documents</Link> to follow
                processing.
              </p>
            </>
          )}
        </section>
      )}
      <Executions
        revision={revision}
        disabled={busy}
        review={(id) => void review(id)}
      />
    </section>
  );
}
