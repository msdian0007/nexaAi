import { Response } from "express";
import { createDocument, getDocumentStatus } from "./document.service";
import { AuthenticatedRequest } from "../auth/auth.middleware";
import path from "path";
import { processDocument } from "./document.processing";

export const documentStatus = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const organizationId = req.user?.organizationId;

    if (typeof organizationId !== "string" || !organizationId.trim()) {
      return res.status(401).json({
        success: false,
        message: "Organization context is missing",
      });
    }

    const { documentId } = req.params;

    if (typeof documentId !== "string" || !documentId.trim()) {
      return res.status(400).json({
        success: false,
        message: "Document ID is required",
      });
    }

    const document = await getDocumentStatus(documentId, organizationId);

    if (!document) {
      return res.status(404).json({
        success: false,
        message: "Document not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: document,
    });
  } catch (error) {
    console.error("Get document status error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch document status",
    });
  }
};

export const uploadDocument = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    if (!req.user) {
      return res.status(401).json({
        message: "Unauthorized",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        message: "Document file is required",
      });
    }

    const document = await createDocument({
      organizationId: req.user.organizationId,
      uploadedById: req.user.userId,

      name: req.file.filename,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storagePath: path.relative(process.cwd(), req.file.path),
    });

    await processDocument(document.id);

    return res.status(201).json({
      message: "Document uploaded successfully",
      document,
    });
  } catch (error) {
    console.error("Upload document error:", error);

    return res.status(500).json({
      message: "Failed to upload document",
    });
  }
};

