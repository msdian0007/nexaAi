import type { buildDocumentContext } from "../document/document.context";
import type { RagAnswer } from "./rag.prompt";

type Source = ReturnType<typeof buildDocumentContext>["sources"][number];
type ValidationCode = "INVALID_JSON" | "INVALID_STRUCTURE" | "INVALID_ANSWER" |
  "INVALID_CITATIONS" | "INVALID_SOURCE_MAP" | "UNKNOWN_CITATION" |
  "CITATION_MISMATCH" | "INVALID_STATUS_CITATIONS";

export class RagResponseValidationError extends Error {
  constructor(public readonly code: ValidationCode, message: string) {
    super(message);
    this.name = "RagResponseValidationError";
  }
}

export const MAX_RESPONSE_CHARS = 32000;
export const MAX_ANSWER_CHARS = 8000;
const SOURCE_ID = /^S[1-9]\d*$/;

// Sources must be the server-owned mapping for the exact context sent to the model.
// This validates structure and references, not whether claims follow from evidence.
export const validateRagResponse = (
  rawResponse: unknown,
  sources: readonly Source[],
): RagAnswer & { sources: Source[] } => {
  if (typeof rawResponse !== "string" || rawResponse.length > MAX_RESPONSE_CHARS) {
    throw new RagResponseValidationError("INVALID_JSON", "Expected a JSON response within the size limit");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawResponse);
  } catch {
    throw new RagResponseValidationError("INVALID_JSON", "Response is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RagResponseValidationError("INVALID_STRUCTURE", "Response must be a JSON object");
  }
  const data = parsed as Record<string, unknown>;
  const keys = Object.keys(data);
  if (keys.length !== 3 || !["status", "answer", "citations"].every(key => keys.includes(key)) ||
      !["answered", "insufficient_information", "conflicting_evidence"].includes(data.status as string)) {
    throw new RagResponseValidationError("INVALID_STRUCTURE", "Response fields or status are invalid");
  }
  if (typeof data.answer !== "string" || !data.answer.trim() || data.answer.length > MAX_ANSWER_CHARS) {
    throw new RagResponseValidationError("INVALID_ANSWER", "Answer must be nonempty and within the size limit");
  }
  if (!Array.isArray(data.citations) || data.citations.some(id => typeof id !== "string" || !SOURCE_ID.test(id)) ||
      new Set(data.citations).size !== data.citations.length) {
    throw new RagResponseValidationError("INVALID_CITATIONS", "Citations must be unique source IDs");
  }
  const citations = data.citations as string[];
  const sourceMap = new Map<string, Source>();
  for (const source of sources) {
    if (!SOURCE_ID.test(source.sourceId) || sourceMap.has(source.sourceId)) {
      throw new RagResponseValidationError("INVALID_SOURCE_MAP", "Source mapping contains invalid or duplicate labels");
    }
    sourceMap.set(source.sourceId, source);
  }

  const inlineCitations = new Set<string>();
  const answerWithoutCitations = data.answer.replace(/\[(S[1-9]\d*)\]/g, (_match, id: string) => {
    inlineCitations.add(id);
    return "";
  });
  if (/[\[\]]/.test(answerWithoutCitations)) {
    throw new RagResponseValidationError("INVALID_CITATIONS", "Square brackets must contain individual source labels like [S1]");
  }
  if ([...citations, ...inlineCitations].some(id => !sourceMap.has(id))) {
    throw new RagResponseValidationError("UNKNOWN_CITATION", "Response cites a source that was not supplied");
  }
  if (inlineCitations.size !== citations.length || citations.some(id => !inlineCitations.has(id))) {
    throw new RagResponseValidationError("CITATION_MISMATCH", "Inline citations and citation list do not agree");
  }
  if ((data.status === "answered" && citations.length < 1) ||
      (data.status === "conflicting_evidence" && citations.length < 2)) {
    throw new RagResponseValidationError("INVALID_STATUS_CITATIONS", "Response status requires more supporting sources");
  }

  return {
    status: data.status as RagAnswer["status"],
    answer: data.answer.trim(),
    citations: [...citations],
    sources: citations.map(id => ({ ...sourceMap.get(id)! })),
  };
};
