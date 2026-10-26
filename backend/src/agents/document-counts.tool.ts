import prisma from "../config/database";
import type { AgentContext, AgentToolResult, DocumentCountsResult } from "./agent.contracts";
import { AgentContractError, parseAgentToolCall } from "./agent.contracts";
import { readAgentContext, requireAgentMembership } from "./agent.access";

export async function executeDocumentCountsTool(
  authenticatedContext: AgentContext,
  proposal: unknown,
): Promise<Extract<AgentToolResult, { tool: "document_counts" }>> {
  const context = readAgentContext(authenticatedContext);
  const call = parseAgentToolCall(proposal);
  if (call.tool !== "document_counts") throw new AgentContractError();

  const data = await prisma.$transaction(async tx => {
    // Prisma exposes isolation/transaction deadlines but no read-only or SQL
    // statement-timeout option. These fixed control statements take no model input.
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
    // Membership and counts use the same RepeatableRead snapshot. No individual
    // document rows, text, paths, Redis jobs or provider calls are needed.
    await requireAgentMembership(context, tx);
    const asOf = new Date().toISOString();
    const groups = await tx.document.groupBy({
      by: ["status"],
      where: { organizationId: context.organizationId, deletionRequestedAt: null },
      _count: { _all: true },
    });
    const byStatus: DocumentCountsResult["byStatus"] = {
      UPLOADED: 0, PROCESSING: 0, COMPLETED: 0, FAILED: 0,
    };
    for (const group of groups) byStatus[group.status] = group._count._all;
    return { asOf, total: Object.values(byStatus).reduce((sum, count) => sum + count, 0), byStatus };
  }, { isolationLevel: "RepeatableRead", timeout: 5000, maxWait: 2000 });

  // Database failures propagate; returning zero would falsely describe an outage
  // as an empty organization. The future router owns safe HTTP error mapping.
  return { tool: "document_counts", data };
}
