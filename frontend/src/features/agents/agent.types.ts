import { parseChatAnswer } from "../chat/chat.types";
import type { ChatAnswer } from "../chat/chat.types";

export const isId = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const date = (v: unknown): v is string =>
  typeof v === "string" && Number.isFinite(Date.parse(v));
const count = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
function object(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("Invalid agent response");
  return v as Record<string, unknown>;
}
export const states = [
  "PENDING",
  "CLAIMED",
  "ACCEPTED",
  "REJECTED",
  "UNCERTAIN",
  "CANCELLED",
] as const;
export type Proposal = {
  id: string;
  tool: "retry_document";
  documentId: string;
  documentName: string;
  expiresAt: string;
  state: (typeof states)[number];
};
export function parseProposal(value: unknown): Proposal {
  const p = object(value);
  if (
    !isId(p.id) ||
    !isId(p.documentId) ||
    p.tool !== "retry_document" ||
    typeof p.documentName !== "string" ||
    !p.documentName ||
    !date(p.expiresAt) ||
    !states.includes(p.state as Proposal["state"])
  )
    throw new Error("Invalid proposal");
  return {
    id: p.id,
    tool: "retry_document",
    documentId: p.documentId,
    documentName: p.documentName,
    expiresAt: p.expiresAt,
    state: p.state as Proposal["state"],
  };
}
export type Counts = {
  asOf: string;
  total: number;
  byStatus: {
    UPLOADED: number;
    PROCESSING: number;
    COMPLETED: number;
    FAILED: number;
  };
};
export type AgentResult =
  | { kind: "knowledge"; answer: ChatAnswer }
  | { kind: "counts"; counts: Counts }
  | { kind: "clarification" | "unsupported"; message: string }
  | { kind: "proposal"; proposal: Proposal };
export function parseEnvelope(value: unknown) {
  const data = object(value);
  if (!isId(data.executionId)) throw new Error("Invalid execution ID");
  return { executionId: data.executionId, result: object(data.result) };
}
export function parseAgentResult(
  value: unknown,
  question: string,
): { executionId: string; result: AgentResult } {
  const { executionId, result: r } = parseEnvelope(value);
  let result: AgentResult;
  if (r.kind === "clarification" || r.kind === "unsupported") {
    const message = r.kind === "clarification" ? r.question : r.message;
    if (typeof message !== "string" || !message.trim() || message.length > 500)
      throw new Error("Invalid agent message");
    result = { kind: r.kind, message };
  } else if (r.kind === "action_proposal")
    result = { kind: "proposal", proposal: parseProposal(r.proposal) };
  else if (r.kind === "tool_result") {
    const tool = object(r.result),
      data = object(tool.data);
    if (tool.tool === "knowledge_answer")
      result = {
        kind: "knowledge",
        answer: parseChatAnswer({ ...data, question }, question),
      };
    else if (tool.tool === "document_counts") {
      const by = object(data.byStatus);
      if (
        !date(data.asOf) ||
        !count(data.total) ||
        Object.keys(by).length !== 4 ||
        ![by.UPLOADED, by.PROCESSING, by.COMPLETED, by.FAILED].every(count) ||
        data.total !==
          (by.UPLOADED as number) +
            (by.PROCESSING as number) +
            (by.COMPLETED as number) +
            (by.FAILED as number)
      )
        throw new Error("Invalid counts");
      result = {
        kind: "counts",
        counts: {
          asOf: data.asOf,
          total: data.total,
          byStatus: {
            UPLOADED: by.UPLOADED as number,
            PROCESSING: by.PROCESSING as number,
            COMPLETED: by.COMPLETED as number,
            FAILED: by.FAILED as number,
          },
        },
      };
    } else throw new Error("Unknown tool result");
  } else throw new Error("Unknown agent result");
  return { executionId, result };
}
export type Execution = {
  id: string;
  operation: string;
  tool: string | null;
  proposalId: string | null;
  outcome: string;
  startedAt: string;
  durationMs: number | null;
};
export function parseExecutions(value: unknown): Execution[] {
  const data = object(value);
  if (!Array.isArray(data.executions) || data.executions.length > 20)
    throw new Error("Invalid execution list");
  const records = data.executions.map((value) => {
    const r = object(value);
    if (
      !isId(r.id) ||
      !["REQUEST", "CONFIRM", "CANCEL"].includes(String(r.operation)) ||
      !(
        r.tool === null ||
        ["knowledge_answer", "document_counts", "retry_document"].includes(
          String(r.tool),
        )
      ) ||
      !(r.proposalId === null || isId(r.proposalId)) ||
      !["STARTED", "SUCCEEDED", "FAILED", "UNCONFIRMED"].includes(
        String(r.outcome),
      ) ||
      !date(r.startedAt) ||
      !(r.durationMs === null || count(r.durationMs))
    )
      throw new Error("Invalid execution");
    return {
      id: r.id,
      operation: String(r.operation),
      tool: r.tool as string | null,
      proposalId: r.proposalId as string | null,
      outcome: String(r.outcome),
      startedAt: r.startedAt,
      durationMs: r.durationMs as number | null,
    };
  });
  if (new Set(records.map((r) => r.id)).size !== records.length)
    throw new Error("Duplicate execution");
  return records;
}
