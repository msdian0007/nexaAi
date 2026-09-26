import prisma from "../config/database";
import { generateEmbedding } from "./document.embedding";

export const embedDocumentChunks = async (
  documentId: string
) => {
  const chunks = await prisma.documentChunk.findMany({
    where: {
      documentId,
      embeddingStatus: "PENDING",
    },
    orderBy: {
      chunkIndex: "asc",
    },
  });

  for (const chunk of chunks) {
    try {
      const embedding = await generateEmbedding(
        chunk.content
      );

      console.log(
        `Generated embedding for chunk ${chunk.chunkIndex}`
      );

      console.log(
        `Embedding dimensions: ${embedding.length}`
      );

      await prisma.documentChunk.update({
        where: {
          id: chunk.id,
        },
        data: {
          embeddingStatus: "COMPLETED",
        },
      });
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