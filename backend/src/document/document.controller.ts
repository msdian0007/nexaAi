import { Response } from "express";
import { createDocument } from "./document.service";
import { AuthenticatedRequest } from "../auth/auth.middleware";
import path from "path";
import { processDocument } from "./document.processing";

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

