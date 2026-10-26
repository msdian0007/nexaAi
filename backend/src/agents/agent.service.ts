import type { AgentContext, AgentToolResult } from "./agent.contracts";
import { readAgentContext, requireAgentMembership } from "./agent.access";
import { readAgentRequest, selectAgentDecision } from "./agent.routing";
import { executeKnowledgeTool } from "./knowledge.tool";
import { executeDocumentCountsTool } from "./document-counts.tool";

export type AgentResponse =
  | {
      kind: "tool_result";
      result: Exclude<AgentToolResult, { tool: "retry_document" }>;
    }
  | { kind: "clarification"; question: string }
  | { kind: "unsupported"; message: string };

export async function runAgentRequest(
  authenticatedContext: AgentContext,
  value: unknown,
): Promise<AgentResponse> {
  const context = readAgentContext(authenticatedContext);
  const request = readAgentRequest(value);
  // Reject removed members before spending a routing request. Model selection
  // does not establish identity or grant permission to run a tool.
  await requireAgentMembership(context);
  const decision = await selectAgentDecision(request);
  // Also withhold clarification/unsupported text after revocation during routing.
  await requireAgentMembership(context);
  if (decision.kind !== "tool") return decision;

  // Explicit dispatch is the execution allowlist: no property lookup/eval, retry
  // executor, automatic fallback, multi-tool loop or automatic model retry.
  switch (decision.call.tool) {
    case "knowledge_answer":
      return {
        kind: "tool_result",
        result: await executeKnowledgeTool(context, decision.call),
      };
    case "document_counts":
      return {
        kind: "tool_result",
        result: await executeDocumentCountsTool(context, decision.call),
      };
    default:
      throw new Error("The selected tool is not enabled.");
  }
}
