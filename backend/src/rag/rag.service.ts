import { measure } from "../observability/telemetry";
import { searchDocumentChunks } from "../document/document.search";
import { buildDocumentContext } from "../document/document.context";
import { generateRagAnswer } from "./rag.generation";
import { generateGeminiText } from "./gemini.provider";

export const answerDocumentQuestion = async (
  organizationId: string,
  question: string,
  topK: number,
  minSimilarity: number,
) => {
  const matches = await measure("retrieval", () => searchDocumentChunks(organizationId, question, topK, minSimilarity));
  const context = buildDocumentContext(matches);
  return measure("generation", () => generateRagAnswer(question, context, generateGeminiText));
};
