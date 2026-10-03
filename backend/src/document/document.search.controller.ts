import { Response } from "express";
import { AuthenticatedRequest } from "../auth/auth.middleware";
import { DEFAULT_MIN_SIMILARITY, searchDocumentChunks } from "./document.search";

export const searchDocuments = async (req: AuthenticatedRequest, res: Response) => {
  const organizationId = req.user?.organizationId;
  if (typeof organizationId !== "string" || !organizationId.trim()) {
    return res.status(401).json({ success: false, message: "Organization context is missing" });
  }

  const query = req.body?.query;
  const topK = req.body?.topK === undefined ? 5 : req.body.topK;
  const minSimilarity = req.body?.minSimilarity === undefined
    ? DEFAULT_MIN_SIMILARITY
    : req.body.minSimilarity;
  if (typeof query !== "string" || !query.trim() || query.trim().length > 1000) {
    return res.status(400).json({ success: false, message: "Query must contain 1 to 1000 characters" });
  }
  if (typeof topK !== "number" || !Number.isInteger(topK) || topK < 1 || topK > 10) {
    return res.status(400).json({ success: false, message: "topK must be an integer from 1 to 10" });
  }
  if (typeof minSimilarity !== "number" || !Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    return res.status(400).json({ success: false, message: "minSimilarity must be a number from 0 to 1" });
  }

  try {
    const results = await searchDocumentChunks(organizationId, query.trim(), topK, minSimilarity);
    const hasMatches = results.length > 0;
    return res.status(200).json({
      success: true,
      message: hasMatches ? "Matching document chunks found" : "No relevant information found",
      data: { query: query.trim(), minSimilarity, hasMatches, results },
    });
  } catch (error) {
    console.error("Document search error:", error);
    return res.status(500).json({ success: false, message: "Document search failed" });
  }
};
