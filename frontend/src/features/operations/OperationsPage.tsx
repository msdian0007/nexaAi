import { useEffect, useRef, useState } from "react";
import { useAuth } from "../auth/auth.context";
import { ApiError } from "../../services/api";

const labels: Record<string, string> = {
  ORGANIZATION_UPDATED: "Organization profile changed", MEMBER_ADDED: "Member added", MEMBER_ROLE_CHANGED: "Member role changed",
  MEMBER_REMOVED: "Member removed", INVITATION_CREATED: "Invitation created", INVITATION_REVOKED: "Invitation revoked",
  INVITATION_ACCEPTED: "Invitation accepted", DOCUMENT_UPLOADED: "Document saved", DOCUMENT_DELETION_REQUESTED: "Document deletion requested",
  DOCUMENT_DELETED: "Document deleted", DOCUMENT_RETRY_REQUESTED: "Document retry requested",
};
const alertLabels: Record<string, string> = {
  QUEUE_UNAVAILABLE: "The document queue is unavailable.", NO_DOCUMENT_WORKER: "No document worker is connected. Queued work will wait.",
  WORKER_STATUS_UNAVAILABLE: "Worker availability could not be checked.",
  DOCUMENT_FAILURES: "Some documents have a saved failed status.", QUEUE_FAILURES: "Some sampled queue jobs have failed.",
  BACKLOG_HIGH: "At least 20 sampled jobs are waiting or delayed.", JOB_STATES_UNAVAILABLE: "Some sampled job states could not be checked.",
};
type Event = { id: string; actorId: string; action: string; targetId: string; requestId: string | null; createdAt: string };
type Audit = { organizationId: string; events: Event[]; nextCursor: string | null };
type Summary = { organizationId: string; observedAt: string; totalDocuments: number; failedDocuments: number; queueAvailable: boolean; workersAvailable: boolean | null; sampleSize: number; sampleTruncated: boolean; states: Record<string, number>; alerts: string[] };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function auditData(v: unknown, organization: string): Audit {
  if (!record(v) || v.organizationId !== organization || !Array.isArray(v.events) || v.events.length > 20 ||
    !(v.nextCursor === null || uuid(v.nextCursor)) || v.events.some(e => !record(e) || !uuid(e.id) || !uuid(e.actorId) || !uuid(e.targetId) ||
      !(e.requestId === null || uuid(e.requestId)) || !date(e.createdAt) || typeof e.action !== "string" || !Object.prototype.hasOwnProperty.call(labels, e.action))) throw new Error("Invalid audit response");
  return v as unknown as Audit;
}
function summaryData(v: unknown, organization: string): Summary {
  const keys = ["waiting", "active", "delayed", "failed", "completed", "unknown", "unavailable"];
  if (!record(v) || v.organizationId !== organization || !date(v.observedAt) || !count(v.totalDocuments) || !count(v.failedDocuments) || v.failedDocuments > v.totalDocuments ||
    !count(v.sampleSize) || v.sampleSize > 50 || v.sampleSize > v.totalDocuments || typeof v.sampleTruncated !== "boolean" ||
    v.sampleTruncated !== (v.totalDocuments > v.sampleSize) || typeof v.queueAvailable !== "boolean" || !(v.workersAvailable === null || typeof v.workersAvailable === "boolean") || !record(v.states) || Object.keys(v.states).length !== keys.length || keys.some(k => !count(v.states && (v.states as Record<string, unknown>)[k])) ||
    keys.reduce((n, k) => n + (v.states as Record<string, number>)[k], 0) !== v.sampleSize ||
    !Array.isArray(v.alerts) || v.alerts.some(a => typeof a !== "string" || !Object.prototype.hasOwnProperty.call(alertLabels, a))) throw new Error("Invalid operations response");
  return v as unknown as Summary;
}

export function OperationsPage() {
  const { session, request } = useAuth();
  const [summary, setSummary] = useState<Summary | null>(null), [audit, setAudit] = useState<Audit | null>(null);
  const [revision, setRevision] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const organization = session?.organization.id ?? "";
  useEffect(() => {
    const controller = new AbortController(); active.current = controller;
    // A refresh clears stale private data. All reads are scoped again by the API;
    // role claims in an old browser session never authorize this view.
    Promise.all([request("/operations/summary", { signal: controller.signal }), request("/operations/audit", { signal: controller.signal })])
      .then(([s, a]) => { if (!controller.signal.aborted) { setSummary(summaryData(s, organization)); setAudit(auditData(a, organization)); } })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted) {
          setSummary(null); setAudit(null);
          setError(failure instanceof ApiError && failure.status === 403 ? "Operations access requires a current owner or administrator membership." : "Operations information could not be loaded. Refresh to try again.");
        }
      }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); active.current?.abort(); };
  }, [organization, request, revision]);
  function refresh() { if (busy) return; setBusy(true); setError(""); setSummary(null); setAudit(null); setRevision(n => n + 1); }
  async function more() {
    if (!audit?.nextCursor || busy) return;
    const cursor = audit.nextCursor, controller = new AbortController(); active.current = controller;
    setBusy(true); setError("");
    try {
      const page = auditData(await request("/operations/audit", { query: { cursor }, signal: controller.signal }), organization);
      if (!controller.signal.aborted) {
        const ids = new Set(audit.events.map(event => event.id));
        if (page.nextCursor === cursor || page.events.some(event => ids.has(event.id))) throw new Error("Repeated audit page");
        setAudit({ ...page, events: [...audit.events, ...page.events] });
      }
    } catch (failure) {
      if (!controller.signal.aborted) {
        if (failure instanceof ApiError && failure.status === 403) { setSummary(null); setAudit(null); }
        setError("More audit history could not be loaded. Refresh to verify current access.");
      }
    } finally { if (!controller.signal.aborted) setBusy(false); }
  }
  if (!session) return null;
  return <section className="workspace operations-page" aria-labelledby="operations-heading">
    <h1 id="operations-heading">Operations and audit history</h1>
    <p>Current organization: {session.organization.name}. Available to current owners and administrators.</p>
    <button onClick={refresh} disabled={busy}>Refresh operations</button>
    {error && <p role="alert">{error}</p>}
    {!summary && !error && <p role="status">Loading operations…</p>}
    {summary && <>
      <h2>Document processing</h2>
      <p>{summary.totalDocuments} saved documents; {summary.failedDocuments} have a failed status.</p>
      <p>Queue: {summary.queueAvailable ? "available" : "unavailable"}. Worker: {summary.workersAvailable === null ? "unknown" : summary.workersAvailable ? "connected" : "not connected"}.</p>
      <p>Checked {new Date(summary.observedAt).toLocaleString()}. Queue states cover {summary.sampleSize} recent documents{summary.sampleTruncated ? "; this is a partial sample" : ""}.</p>
      {summary.alerts.length ? <ul aria-label="Operational alerts">{summary.alerts.map(code => <li key={code}>{alertLabels[code]}</li>)}</ul> : <p>No configured alert conditions detected in this observation.</p>}
      <dl className="account-details">{Object.entries(summary.states).map(([state, n]) => <div key={state}><dt>{state}</dt><dd>{n}</dd></div>)}</dl>
    </>}
    {audit && <>
      <h2>Organization audit history</h2>
      <p>Identifiers link an action to its actor, target and request without copying private content. Historical entries begin when auditing was enabled.</p>
      {!audit.events.length ? <p>No recorded actions.</p> : <div className="operations-table"><table><thead><tr><th>Time</th><th>Action</th><th>Actor ID</th><th>Target ID</th><th>Request ID</th></tr></thead>
        <tbody>{audit.events.map(event => <tr key={event.id}><td>{new Date(event.createdAt).toLocaleString()}</td><td>{labels[event.action]}</td><td>{event.actorId}</td><td>{event.targetId}</td><td>{event.requestId ?? "Not recorded"}</td></tr>)}</tbody></table></div>}
      {audit.nextCursor && audit.events.length < 200 && <button onClick={() => void more()} disabled={busy}>Load more audit events</button>}
      {audit.events.length >= 200 && <p>Showing the 200 most recent loaded events. Refresh to check new activity.</p>}
    </>}
  </section>;
}
