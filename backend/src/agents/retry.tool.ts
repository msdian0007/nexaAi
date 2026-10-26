import prisma from "../config/database";
import type { AgentContext, AgentToolResult } from "./agent.contracts";
import { AgentContractError, parseAgentToolCall } from "./agent.contracts";
import { readAgentContext, requireAgentMembership } from "./agent.access";
import { getDocumentQueue, QueueProvider } from "../document/document.queue.runtime";
import { resolveDocumentStatus } from "../document/document.service";
import { withDocumentSubmissionLock } from "../document/document.deletion";

export class AgentActionError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) { super(message); }
}

function proposalId(value: unknown): string {
  // Confirmation/cancellation are separate server operations. The model cannot
  // provide an approval boolean, replacement document ID or forged context here.
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(value, "proposalId") || !("proposalId" in value) || typeof value.proposalId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.proposalId)) {
    throw new AgentActionError("INVALID_PROPOSAL_REQUEST", 400, "Provide only the proposal ID.");
  }
  return value.proposalId;
}

function view(p: { id: string; documentId: string; documentName: string; expiresAt: Date; state: string }) {
  return { id: p.id, tool: "retry_document" as const, documentId: p.documentId,
    documentName: p.documentName, expiresAt: p.expiresAt.toISOString(), state: p.state };
}
export type RetryProposalView = ReturnType<typeof view>;

async function eligible(context: AgentContext, documentId: string, queueProvider: QueueProvider) {
  const document = await prisma.document.findFirst({ where: { id: documentId, organizationId: context.organizationId },
    select: { id: true, originalName: true, updatedAt: true, status: true, deletionRequestedAt: true } });
  if (!document) throw new AgentActionError("DOCUMENT_UNAVAILABLE", 404, "Document is unavailable.");
  const status = await resolveDocumentStatus(document, context.organizationId, queueProvider);
  if (status.processingState === "UNAVAILABLE") throw new AgentActionError("QUEUE_UNAVAILABLE", 503, "Refresh document status before trying again.");
  if (!status.canRetry) throw new AgentActionError("DOCUMENT_CHANGED", 409, "Document is not eligible. Refresh its status.");
  return { document, status };
}

export async function proposeDocumentRetry(authenticatedContext: AgentContext, value: unknown,
  queueProvider: QueueProvider = getDocumentQueue): Promise<RetryProposalView> {
  const context = readAgentContext(authenticatedContext);
  const call = parseAgentToolCall(value);
  if (call.tool !== "retry_document") throw new AgentContractError();
  await requireAgentMembership(context);
  // Check scope before acquiring locks or accessing Redis; foreign/missing IDs
  // have the same response. The lock repeats the current membership/state checks.
  const exists = await prisma.document.findFirst({ where: { id: call.input.documentId, organizationId: context.organizationId }, select: { id: true } });
  if (!exists) throw new AgentActionError("DOCUMENT_UNAVAILABLE", 404, "Document is unavailable.");
  return withDocumentSubmissionLock(call.input.documentId, context.organizationId, async () => {
    const { document } = await eligible(context, call.input.documentId, queueProvider);
    // No queue write happens while proposing. Persist the exact version the user
    // will review; membership deletion cascades remove its outstanding proposals.
    const proposal = await prisma.agentRetryProposal.create({ data: { ...context,
      documentId: document.id, documentName: document.originalName, documentUpdatedAt: document.updatedAt,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000) } });
    return view(proposal);
  }, context.userId);
}

export async function readRetryProposal(authenticatedContext: AgentContext, value: unknown): Promise<RetryProposalView> {
  const context = readAgentContext(authenticatedContext), id = proposalId(value);
  await requireAgentMembership(context);
  const proposal = await prisma.agentRetryProposal.findFirst({ where: { id, ...context } });
  if (!proposal) throw new AgentActionError("PROPOSAL_UNAVAILABLE", 404, "Proposal is unavailable.");
  return view(proposal);
}

export async function cancelRetryProposal(authenticatedContext: AgentContext, value: unknown): Promise<RetryProposalView> {
  const context = readAgentContext(authenticatedContext), id = proposalId(value);
  await requireAgentMembership(context);
  const changed = await prisma.agentRetryProposal.updateMany({ where: { id, ...context, state: "PENDING" },
    data: { state: "CANCELLED", consumedAt: new Date() } });
  if (!changed.count) throw new AgentActionError("PROPOSAL_UNAVAILABLE", 409, "Proposal is no longer pending.");
  return readRetryProposal(context, { proposalId: id });
}

export async function confirmDocumentRetry(authenticatedContext: AgentContext, value: unknown,
  queueProvider: QueueProvider = getDocumentQueue): Promise<Extract<AgentToolResult, { tool: "retry_document" }>> {
  const context = readAgentContext(authenticatedContext), id = proposalId(value);
  const proposal = await prisma.$transaction(async tx => {
    await requireAgentMembership(context, tx);
    const row = await tx.agentRetryProposal.findFirst({ where: { id, ...context } });
    if (!row) throw new AgentActionError("PROPOSAL_UNAVAILABLE", 404, "Proposal is unavailable.");
    const now = new Date();
    if (row.expiresAt <= now) throw new AgentActionError("PROPOSAL_EXPIRED", 410, "Proposal expired. Create a new proposal.");
    const claimed = await tx.agentRetryProposal.updateMany({ where: { id, ...context, state: "PENDING", expiresAt: { gt: now } },
      data: { state: "CLAIMED", consumedAt: now } });
    if (!claimed.count) throw new AgentActionError("PROPOSAL_USED", 409, "Proposal was already used or cancelled. Refresh document status.");
    return row;
  });

  // Claim commits BEFORE touching Redis. A crash or a lost queue acknowledgement
  // leaves a consumed proposal; neither replay nor restart can submit it again.
  let writeStarted = false;
  let connecting: ReturnType<QueueProvider> | undefined;
  const sharedQueue: QueueProvider = () => connecting ??= queueProvider();
  try {
    await withDocumentSubmissionLock(proposal.documentId, context.organizationId, async () => {
      const { document, status } = await eligible(context, proposal.documentId, sharedQueue);
      if (document.updatedAt.getTime() !== proposal.documentUpdatedAt.getTime() || document.originalName !== proposal.documentName) {
        throw new AgentActionError("DOCUMENT_CHANGED", 409, "Document changed. Review a new proposal.");
      }
      // Repeat expiry after waiting for the organization/document submission lock.
      if (proposal.expiresAt.getTime() <= Date.now()) throw new AgentActionError("PROPOSAL_EXPIRED", 410, "Proposal expired. Create a new proposal.");
      const queue = await sharedQueue();
      const ids = { documentId: document.id, organizationId: context.organizationId };
      writeStarted = true;
      if (status.processingState === "FAILED") await queue.retryFailed(ids);
      else await queue.enqueue(ids);
    }, context.userId);
    const saved = await prisma.agentRetryProposal.updateMany({ where: { id, ...context, state: "CLAIMED" }, data: { state: "ACCEPTED" } });
    if (!saved.count) throw new Error("Proposal acknowledgement unavailable.");
    return { tool: "retry_document", data: { documentId: proposal.documentId, state: "accepted" } };
  } catch (error) {
    // Best-effort receipt update. Even if it fails, CLAIMED is durable and cannot
    // be reused. Never auto-repeat a write whose outcome may be uncertain.
    await prisma.agentRetryProposal.updateMany({ where: { id, ...context, state: "CLAIMED" },
      data: { state: writeStarted ? "UNCERTAIN" : "REJECTED" } }).catch(() => undefined);
    if (writeStarted) throw new AgentActionError("SUBMISSION_UNCONFIRMED", 503, "Submission could not be confirmed. Refresh document status before making a new proposal.");
    throw error;
  }
}
