import type { AgentContext, AgentToolResult } from "./agent.contracts";
import { AgentContractError, parseAgentToolCall } from "./agent.contracts";
import { readAgentContext, requireAgentMembership } from "./agent.access";
import { answerDocumentQuestion } from "../rag/rag.service";
import { DEFAULT_MIN_SIMILARITY } from "../document/document.search";

export async function executeKnowledgeTool(
  authenticatedContext: AgentContext,
  proposal: unknown,
): Promise<Extract<AgentToolResult, { tool: "knowledge_answer" }>> {
  const context = readAgentContext(authenticatedContext);
  // Revalidate at the execution boundary, even if routing already parsed the
  // model's proposal. This function can only run the knowledge tool.
  const call = parseAgentToolCall(proposal);
  if (call.tool !== "knowledge_answer") throw new AgentContractError();
  await requireAgentMembership(context);

  // Reuse tenant-scoped retrieval, bounded context and citation validation.
  // Search settings are owned by the server, not supplied by the model.
  // No transaction or membership lock stays open while embeddings/Gemini run.
  const data = await answerDocumentQuestion(
    context.organizationId,
    call.input.question,
    5,
    DEFAULT_MIN_SIMILARITY,
  );

  // Generation may take time. Withhold the result if membership was removed
  // while it ran; a browser cancellation alone is not an authorization check.
  await requireAgentMembership(context);
  return { tool: "knowledge_answer", data };
}
