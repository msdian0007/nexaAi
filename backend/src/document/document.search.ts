import prisma from "../config/database";
import { generateEmbedding } from "./document.embedding";

// Initial retrieval cutoff; calibrate against representative document/question pairs.
export const DEFAULT_MIN_SIMILARITY = 0.35;

export interface SearchResult {
  chunkId: string;
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  similarity: number;
}

export const searchDocumentChunks = async (
  organizationId: string,
  query: string,
  topK: number,
  minSimilarity: number = DEFAULT_MIN_SIMILARITY,
): Promise<SearchResult[]> => {
  if (!organizationId.trim()) throw new Error("Organization context is required");
  if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new Error("minSimilarity must be a number from 0 to 1");
  }
  const embedding = await generateEmbedding(query);
  if (embedding.length !== 384 || !embedding.every(Number.isFinite) || !embedding.some(value => value !== 0)) {
    throw new Error("Invalid query embedding");
  }
  const vector = `[${embedding.join(",")}]`;

  // Exact search over this tenant's eligible chunks avoids approximate-index
  // filtering dropping matches. Revisit indexing as the corpus grows.
  return prisma.$queryRaw<SearchResult[]>`
    WITH eligible AS MATERIALIZED (
      SELECT c."id" AS "chunkId", c."documentId", d."originalName" AS "documentName",
             c."chunkIndex", c."content", c."embedding"
      FROM "DocumentChunk" c
      JOIN "Document" d ON d."id" = c."documentId"
      WHERE d."organizationId" = ${organizationId}
        AND d."status" = 'COMPLETED'
        AND c."embeddingStatus" = 'COMPLETED'
        AND c."embedding" IS NOT NULL
        AND vector_norm(c."embedding") > 0
    )
    SELECT "chunkId", "documentId", "documentName", "chunkIndex", "content",
           1 - ("embedding" <=> ${vector}::vector(384)) AS "similarity"
    FROM eligible
    WHERE 1 - ("embedding" <=> ${vector}::vector(384)) >= ${minSimilarity}
    ORDER BY "embedding" <=> ${vector}::vector(384), "chunkId"
    LIMIT ${topK}
  `;
};
