import type {
  AgentContext,
  AgentToolResult,
  AgentToolCall,
} from "./agent.contracts";
import { readAgentContext, requireAgentMembership } from "./agent.access";
import { readAgentRequest, selectAgentDecision } from "./agent.routing";
import { executeKnowledgeTool } from "./knowledge.tool";
import { executeDocumentCountsTool } from "./document-counts.tool";
import { proposeDocumentRetry } from "./retry.tool";
import type { RetryProposalView } from "./retry.tool";
import type { QueueProvider } from "../document/document.queue.runtime";

export type AgentResponse =
  | {
      kind: "tool_result";
      result: Exclude<AgentToolResult, { tool: "retry_document" }>;
    }
  | { kind: "clarification"; question: string }
  | { kind: "action_proposal"; proposal: RetryProposalView }
  | { kind: "unsupported"; message: string };

export async function runAgentRequest(
  authenticatedContext: AgentContext,
  value: unknown,
  options: {
    queueProvider?: QueueProvider;
    onToolSelected?: (tool: AgentToolCall["tool"]) => Promise<void>;
  } = {},
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
  // The HTTP layer records only the selected name, before any tool work begins.
  await options.onToolSelected?.(decision.call.tool);

  // Explicit dispatch is the execution allowlist. An action decision can create
  // a proposal only; confirmation is never reachable from this model-driven path.
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
    case "retry_document":
      return {
        kind: "action_proposal",
        proposal: await proposeDocumentRetry(
          context,
          decision.call,
          options.queueProvider,
        ),
      };
    default:
      throw new Error("The selected tool is not enabled.");
  }
}
