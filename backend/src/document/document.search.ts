import prisma from "../config/database";
import { generateEmbedding } from "./document.embedding";

interface SearchResult {
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
): Promise<SearchResult[]> => {
  if (!organizationId.trim()) throw new Error("Organization context is required");
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
    ORDER BY "embedding" <=> ${vector}::vector(384), "chunkId"
    LIMIT ${topK}
  `;
};
