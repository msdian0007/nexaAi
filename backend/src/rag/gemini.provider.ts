import type { GenerateAnswerText } from "./rag.generation";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
type ProviderErrorCode = "CONFIGURATION" | "TIMEOUT" | "NETWORK" | "QUOTA" |
  "AUTHENTICATION" | "MODEL_UNAVAILABLE" | "REQUEST_REJECTED" | "UNAVAILABLE" |
  "BLOCKED" | "INCOMPLETE_RESPONSE" | "INVALID_RESPONSE";

export class GeminiProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "GeminiProviderError";
  }
}

const answerSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["answered", "insufficient_information", "conflicting_evidence"] },
    answer: { type: "string" },
    citations: { type: "array", items: { type: "string" } },
  },
  required: ["status", "answer", "citations"],
  additionalProperties: false,
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};

export const createGeminiGenerator = (options: {
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
} = {}): GenerateAnswerText => async messages => {
  // Resolve configuration at call time: empty-context fallback needs no API key.
  const apiKey = (options.apiKey ?? process.env.GEMINI_API_KEY)?.trim();
  const model = (options.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL).trim();
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!apiKey) throw new GeminiProviderError("CONFIGURATION", "GEMINI_API_KEY is not configured");
  if (!/^gemini-[a-z0-9.-]+$/.test(model) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new GeminiProviderError("CONFIGURATION", "Gemini model or timeout configuration is invalid");
  }
  const system = messages.find(message => message.role === "system");
  const user = messages.find(message => message.role === "user");
  if (messages.length !== 2 || !system || !user) {
    throw new GeminiProviderError("CONFIGURATION", "Expected one system message and one user message");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system.content }] },
          contents: [{ role: "user", parts: [{ text: user.content }] }],
          generationConfig: {
            candidateCount: 1,
            maxOutputTokens: 4096,
            responseFormat: { text: { mimeType: "APPLICATION_JSON", schema: answerSchema } },
          },
        }),
      },
    );
    if (!response.ok) {
      // Never propagate provider error bodies: they may contain request details.
      await response.body?.cancel();
      if (response.status === 429) throw new GeminiProviderError("QUOTA", "Gemini quota or rate limit reached");
      if (response.status === 401 || response.status === 403) throw new GeminiProviderError("AUTHENTICATION", "Gemini credentials or access were rejected");
      if (response.status === 404) throw new GeminiProviderError("MODEL_UNAVAILABLE", "The configured Gemini model is unavailable");
      if (response.status >= 500) throw new GeminiProviderError("UNAVAILABLE", "Gemini is temporarily unavailable");
      throw new GeminiProviderError("REQUEST_REJECTED", "Gemini rejected the generation request");
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (controller.signal.aborted) throw new GeminiProviderError("TIMEOUT", "Gemini request timed out");
      throw new GeminiProviderError("INVALID_RESPONSE", "Gemini returned an unreadable response");
    }
    const body = record(payload);
    if (record(body.promptFeedback).blockReason) {
      throw new GeminiProviderError("BLOCKED", "Gemini could not process this prompt");
    }
    if (!Array.isArray(body.candidates) || body.candidates.length !== 1) {
      throw new GeminiProviderError("INVALID_RESPONSE", "Gemini returned no single answer candidate");
    }
    const candidate = record(body.candidates[0]);
    if (["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"].includes(String(candidate.finishReason))) {
      throw new GeminiProviderError("BLOCKED", "Gemini could not provide this answer");
    }
    if (candidate.finishReason !== "STOP") {
      throw new GeminiProviderError("INCOMPLETE_RESPONSE", "Gemini did not finish the answer");
    }
    const parts = record(candidate.content).parts;
    if (!Array.isArray(parts)) throw new GeminiProviderError("INVALID_RESPONSE", "Gemini returned no answer text");
    const text = parts.filter(part => record(part).thought !== true)
      .map(part => record(part).text).filter((part): part is string => typeof part === "string").join("");
    if (!text.trim()) throw new GeminiProviderError("INVALID_RESPONSE", "Gemini returned empty answer text");
    return text;
  } catch (error) {
    if (error instanceof GeminiProviderError) throw error;
    if (controller.signal.aborted) throw new GeminiProviderError("TIMEOUT", "Gemini request timed out");
    throw new GeminiProviderError("NETWORK", "Could not reach Gemini");
  } finally {
    clearTimeout(timer);
  }
};

export const generateGeminiText = createGeminiGenerator();
