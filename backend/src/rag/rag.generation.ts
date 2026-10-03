import type { buildDocumentContext } from "../document/document.context";
import { buildRagPrompt } from "./rag.prompt";
import { validateRagResponse } from "./rag.response";

type Context = ReturnType<typeof buildDocumentContext>;
type PreparedPrompt = Extract<ReturnType<typeof buildRagPrompt>, { shouldGenerate: true }>;

// A provider adapter accepts our prepared messages and returns raw answer text.
// It will own transport, credentials, timeout, and provider-specific errors.
export type GenerateAnswerText = (messages: PreparedPrompt["messages"]) => Promise<string>;

export const generateRagAnswer = async (
  question: string,
  context: Context,
  generateText: GenerateAnswerText,
) => {
  const prepared = buildRagPrompt(question, context);
  if (!prepared.shouldGenerate) {
    return validateRagResponse(JSON.stringify(prepared.response), []);
  }

  const rawAnswer = await generateText(prepared.messages);
  return validateRagResponse(rawAnswer, prepared.sources);
};
