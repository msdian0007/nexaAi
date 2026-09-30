import prisma from "../config/database";

export const getDocumentStatus = async (
  documentId: string,
  organizationId: string,
) => {
  const document = await prisma.document.findFirst({
    where: {
      id: documentId,
      organizationId,
    },
    select: {
      id: true,
      originalName: true,
      status: true,
      updatedAt: true,
    },
  });

  if (!document) {
    return null;
  }

  return {
    ...document,
    // Stored exception messages can contain internal file paths or database details.
    errorMessage: document.status === "FAILED" ? "Document processing failed." : null,
  };
};

interface CreateDocumentInput {
  organizationId: string;
  uploadedById: string;
  name: string;
  originalName: string;
  mimeType: string;
  size: number;
  storagePath: string;
}

export const createDocument = async (data: CreateDocumentInput) => {
  return prisma.document.create({
    data: {
      organizationId: data.organizationId,
      uploadedById: data.uploadedById,
      name: data.name,
      originalName: data.originalName,
      mimeType: data.mimeType,
      size: data.size,
      storagePath: data.storagePath,
    },
  });
};
