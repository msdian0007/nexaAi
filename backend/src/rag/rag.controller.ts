import { Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware";
import { DEFAULT_MIN_SIMILARITY } from "../document/document.search";
import { answerDocumentQuestion } from "./rag.service";
import { GeminiProviderError } from "./gemini.provider";
import { RagResponseValidationError } from "./rag.response";

export const queryDocuments = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  const organizationId = req.user?.organizationId;
  if (typeof organizationId !== "string" || !organizationId.trim()) {
    return res
      .status(401)
      .json({ success: false, message: "Organization context is missing" });
  }
  const question = req.body?.question;
  const topK = req.body?.topK === undefined ? 5 : req.body.topK;
  const minSimilarity =
    req.body?.minSimilarity === undefined
      ? DEFAULT_MIN_SIMILARITY
      : req.body.minSimilarity;
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.trim().length > 1000
  ) {
    return res
      .status(400)
      .json({
        success: false,
        message: "Question must contain 1 to 1000 characters",
      });
  }
  if (
    typeof topK !== "number" ||
    !Number.isInteger(topK) ||
    topK < 1 ||
    topK > 10
  ) {
    return res
      .status(400)
      .json({
        success: false,
        message: "topK must be an integer from 1 to 10",
      });
  }
  if (
    typeof minSimilarity !== "number" ||
    !Number.isFinite(minSimilarity) ||
    minSimilarity < 0 ||
    minSimilarity > 1
  ) {
    return res
      .status(400)
      .json({
        success: false,
        message: "minSimilarity must be a number from 0 to 1",
      });
  }
  try {
    const answer = await answerDocumentQuestion(
      organizationId,
      question.trim(),
      topK,
      minSimilarity,
    );
    return res
      .status(200)
      .json({ success: true, data: { question: question.trim(), ...answer } });
  } catch (error) {
    // Log only known codes, never prompts, document passages, credentials or provider bodies.
    if (error instanceof RagResponseValidationError) {
      console.error("RAG response rejected:", error.code);
      return res
        .status(502)
        .json({
          success: false,
          code: "INVALID_ANSWER",
          message: "The generated answer failed validation. Please try again.",
        });
    }
    if (error instanceof GeminiProviderError) {
      console.error("RAG provider failure:", error.code);
      if (error.code === "TIMEOUT") {
        return res
          .status(504)
          .json({
            success: false,
            code: "GENERATION_TIMEOUT",
            message: "Answer generation timed out. Please try again.",
          });
      }
      if (error.code === "BLOCKED") {
        return res
          .status(422)
          .json({
            success: false,
            code: "GENERATION_BLOCKED",
            message: "The answer provider could not process this request.",
          });
      }
      if (
        [
          "INVALID_RESPONSE",
          "INCOMPLETE_RESPONSE",
          "REQUEST_REJECTED",
        ].includes(error.code)
      ) {
        return res
          .status(502)
          .json({
            success: false,
            code: "GENERATION_FAILED",
            message:
              "The answer provider did not return a usable response. Please try again.",
          });
      }
      return res
        .status(503)
        .json({
          success: false,
          code: "GENERATION_UNAVAILABLE",
          message:
            "Answer generation is currently unavailable. Please try again later.",
        });
    }
    console.error("RAG query failed unexpectedly");
    return res
      .status(500)
      .json({
        success: false,
        code: "QUERY_FAILED",
        message: "Unable to answer the question. Please try again.",
      });
  }
};
