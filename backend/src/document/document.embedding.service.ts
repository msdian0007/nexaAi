import prisma from "../config/database";
import { generateEmbedding } from "./document.embedding";

export const embedDocumentChunks = async (
  documentId: string
) => {
  const chunks = await prisma.$queryRaw<
    { id: string; content: string; chunkIndex: number }[]
  >`
    SELECT "id", "content", "chunkIndex"
    FROM "DocumentChunk"
    WHERE "documentId" = ${documentId}
      AND (
        "embeddingStatus" IN ('PENDING', 'FAILED')
        OR ("embeddingStatus" = 'COMPLETED' AND "embedding" IS NULL)
      )
    ORDER BY "chunkIndex" ASC
  `;

  for (const chunk of chunks) {
    try {
      const embedding = await generateEmbedding(
        chunk.content
      );

      if (embedding.length !== 384 || !embedding.every(Number.isFinite)) {
        throw new Error("Expected an embedding with 384 finite values");
      }

      const vector = `[${embedding.join(",")}]`;

      await prisma.$executeRaw`
        UPDATE "DocumentChunk"
        SET "embedding" = ${vector}::vector(384),
            "embeddingStatus" = 'COMPLETED'
        WHERE "id" = ${chunk.id} AND "documentId" = ${documentId}
      `;

      console.log(`Stored embedding for chunk ${chunk.chunkIndex}`);

      console.log(
        `Embedding dimensions: ${embedding.length}`
      );

    } catch (error) {
      console.error(
        `Failed to generate embedding for chunk ${chunk.chunkIndex}`,
        error
      );

      await prisma.documentChunk.update({
        where: {
          id: chunk.id,
        },
        data: {
          embeddingStatus: "FAILED",
        },
      });

      throw error;
    }
  }

  return {
    documentId,
    processedChunks: chunks.length,
  };
};
