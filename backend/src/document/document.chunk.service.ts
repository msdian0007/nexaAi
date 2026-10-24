import prisma from "../config/database";
import type { Prisma } from "../../generated/prisma/client";
import { chunkText } from "./document.chunker";

export const createDocumentChunks = async (
  documentId: string,
  extractedText: string,
  db: Prisma.TransactionClient = prisma,
) => {
  const chunks = chunkText(extractedText);

  if (chunks.length === 0) {
    return [];
  }

  await db.documentChunk.deleteMany({
    where: {
      documentId,
    },
  });

  await db.documentChunk.createMany({
    data: chunks.map((chunk) => ({
      documentId,
      content: chunk.content,
      chunkIndex: chunk.chunkIndex,
    })),
  });

  return chunks;
};
