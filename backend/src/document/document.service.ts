import prisma from "../config/database";

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