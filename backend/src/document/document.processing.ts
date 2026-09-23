import prisma from "../config/database";
import { extractTextFromDocument } from "./document.extractor";

export const processDocument = async (documentId: string) => {
  const document = await prisma.document.findUnique({
    where: {
      id: documentId,
    },
  });

  if (!document) {
    throw new Error("Document not found");
  }

  try {
    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        status: "PROCESSING",
        errorMessage: null,
      },
    });

    const extractedText = await extractTextFromDocument(
      document.storagePath,
      document.mimeType
    );

    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        extractedText,
        status: "COMPLETED",
      },
    });

    return {
      documentId,
      status: "COMPLETED",
      textLength: extractedText.length,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Document processing failed";

    await prisma.document.update({
      where: {
        id: documentId,
      },
      data: {
        status: "FAILED",
        errorMessage: message,
      },
    });

    throw error;
  }
};