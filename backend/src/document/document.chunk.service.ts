import prisma from "../config/database";
import { chunkText } from "./document.chunker";

export const createDocumentChunks = async (
  documentId: string,
  extractedText: string
) => {
  const chunks = chunkText(extractedText);

  if (chunks.length === 0) {
    return [];
  }

  await prisma.documentChunk.deleteMany({
    where: {
      documentId,
    },
  });

  await prisma.documentChunk.createMany({
    data: chunks.map((chunk) => ({
      documentId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
    })),
  });

  return chunks;
};