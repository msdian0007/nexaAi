import { Response } from "express";
import {
  createDocument,
  documentView,
  getDocumentStatus,
} from "./document.service";
import { AuthenticatedRequest } from "../auth/auth.middleware";
import path from "path";
import { randomUUID } from "node:crypto";
import prisma from "../config/database";
import { deleteStoredDocument, putStoredDocument, storagePathFor } from "./document.storage";
import { getDocumentQueue, QueueProvider } from "./document.queue.runtime";
import { DocumentJobRetryError } from "./document.queue";
import { deleteOrganizationDocument, DocumentDeletionError, requireProcessingMembership, withDocumentSubmissionLock } from "./document.deletion";
import {
  DocumentLibraryError,
  libraryPageInput,
  libraryUuid,
  listOrganizationDocuments,
} from "./document.library";

// Test applications can provide an isolated queue; production uses the shared producer.
const queueFor = (req: AuthenticatedRequest): QueueProvider =>
  req.app.locals.getDocumentQueue ?? getDocumentQueue;

export const deleteDocument = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?.userId, organizationId = req.user?.organizationId, documentId = req.params.documentId;
    if (typeof userId !== "string" || !libraryUuid.test(userId) || typeof organizationId !== "string" || !libraryUuid.test(organizationId))
      throw new DocumentDeletionError(401, "Valid identity is required");
    if (typeof documentId !== "string" || !libraryUuid.test(documentId) || Object.keys(req.query).length ||
        (req.body !== undefined && (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || Object.keys(req.body).length)))
      throw new DocumentDeletionError(400, "Provide only the document ID in the URL");
    const data = await deleteOrganizationDocument(organizationId, userId, documentId, queueFor(req));
    return res.status(data.cleanupPending ? 202 : 200).json({ success: true, data });
  } catch (error) {
    return res.status(error instanceof DocumentDeletionError ? error.status : 500).json({ success: false,
      message: "Document deletion could not be completed. Refresh the library before trying again." });
  }
};

export const documentLibrary = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const userId = req.user?.userId,
      organizationId = req.user?.organizationId;
    if (
      typeof userId !== "string" ||
      !libraryUuid.test(userId) ||
      typeof organizationId !== "string" ||
      !libraryUuid.test(organizationId)
    )
      throw new DocumentLibraryError(
        401,
        "Valid user and organization context is required",
      );
    const { limit, cursor } = libraryPageInput(req.query, organizationId);
    return res.json({
      success: true,
      data: await listOrganizationDocuments(
        organizationId,
        userId,
        limit,
        cursor,
        queueFor(req),
      ),
    });
  } catch (error) {
    const status = error instanceof DocumentLibraryError ? error.status : 500;
    return res
      .status(status)
      .json({ success: false, message: "Could not load document library" });
  }
};

function identity(req: AuthenticatedRequest, res: Response) {
  const organizationId = req.user?.organizationId;
  if (typeof organizationId !== "string" || !organizationId.trim()) {
    res
      .status(401)
      .json({ success: false, message: "Organization context is missing" });
    return null;
  }
  const documentId = req.params.documentId;
  if (typeof documentId !== "string" || !documentId.trim()) {
    res
      .status(400)
      .json({ success: false, message: "Document ID is required" });
    return null;
  }
  return { documentId, organizationId };
}

export const reprocessDocument = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  const ids = identity(req, res);
  if (!ids) return;
  try {
    if (typeof req.user?.userId !== "string" || !libraryUuid.test(req.user.userId))
      return res.status(401).json({ success: false, message: "Valid user identity is required" });
    await requireProcessingMembership(req.user.userId, ids.organizationId);
    // Scope the database read before touching Redis. A caller cannot retry another tenant's job.
    const document = await getDocumentStatus(
      ids.documentId,
      ids.organizationId,
      queueFor(req),
    );
    if (!document)
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });
    if (document.processingState === "UNAVAILABLE") {
      return res
        .status(503)
        .json({
          success: false,
          code: "DOCUMENT_QUEUE_UNAVAILABLE",
          data: document,
        });
    }
    if (!document.canRetry) {
      return res
        .status(409)
        .json({
          success: false,
          message: "Document is already queued, processing, or ready",
        });
    }
    await withDocumentSubmissionLock(ids.documentId, ids.organizationId, async () => {
      const queue = await queueFor(req)();
      if (document.processingState === "FAILED") await queue.retryFailed(ids);
      else await queue.enqueue(ids);
    }, req.user.userId);
    return res.status(202).json({
      success: true,
      message: "Document accepted for background processing",
      data: documentView(document, "QUEUED"),
    });
  } catch (error) {
    if (error instanceof DocumentDeletionError && error.status === 403)
      return res.status(403).json({ success: false, message: "Current organization membership is required" });
    if (error instanceof DocumentJobRetryError || error instanceof DocumentDeletionError) {
      return res
        .status(409)
        .json({
          success: false,
          message: "Job state changed. Refresh document status.",
        });
    }
    console.error("Document retry submission failed.");
    return res
      .status(503)
      .json({
        success: false,
        code: "DOCUMENT_QUEUE_UNAVAILABLE",
        message:
          "Could not confirm processing submission. Refresh document status.",
      });
  }
};

export const documentStatus = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  const ids = identity(req, res);
  if (!ids) return;
  try {
    await requireProcessingMembership(req.user!.userId, ids.organizationId);
    const document = await getDocumentStatus(
      ids.documentId,
      ids.organizationId,
      queueFor(req),
    );
    if (!document)
      return res
        .status(404)
        .json({ success: false, message: "Document not found" });
    return res.status(200).json({ success: true, data: document });
  } catch (error) {
    if (error instanceof DocumentDeletionError && error.status === 403)
      return res.status(403).json({ success: false, code: "MEMBERSHIP_REQUIRED", message: "Current membership is required." });
    console.error("Get document status failed.");
    return res
      .status(500)
      .json({ success: false, message: "Failed to fetch document status" });
  }
};

export const uploadDocument = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  if (!req.user?.organizationId)
    return res.status(401).json({ success: false, message: "Unauthorized" });
  if (!req.file)
    return res
      .status(400)
      .json({ success: false, message: "Document file is required" });
  let saved = false;
  // Keep an identity before the transaction, so a lost commit acknowledgement
  // can be reconciled without deleting a file belonging to a committed record.
  const documentId = randomUUID();
  const organizationId = req.user.organizationId;
  const storagePath = storagePathFor(organizationId, documentId, req.file.originalname);
  let storageAttempted = false;
  try {
    // Store private bytes first. If the following database commit is known to be
    // absent, the catch path removes this exact generated object.
    storageAttempted = true;
    await putStoredDocument(storagePath, organizationId, documentId, req.file.mimetype, req.file.buffer);
    const document = await createDocument({
      id: documentId,
      organizationId,
      uploadedById: req.user.userId,
      name: path.basename(storagePath),
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      storagePath,
    });
    saved = true;
    try {
      const organizationId = req.user.organizationId;
      await withDocumentSubmissionLock(document.id, organizationId, async () => {
        const queue = await queueFor(req)();
        await queue.enqueue({ documentId: document.id, organizationId });
      });
    } catch {
      // A lost acknowledgement does not prove Redis rejected the job. Keep the
      // file/record and return its ID; do not overwrite a worker's status or reupload.
      return res.status(503).json({
        success: false,
        code: "DOCUMENT_QUEUE_UNAVAILABLE",
        message:
          "File saved, but processing submission could not be confirmed. Check its status.",
        data: documentView(document, "UNAVAILABLE"),
      });
    }
    const accepted = documentView(document, "QUEUED");
    return res.status(202).json({
      success: true,
      message: "Document accepted for background processing",
      data: accepted,
      document: accepted,
    });
  } catch (error) {
    // Verify absence before unlinking: an exception alone does not prove that a
    // commit failed. Keep ambiguous files for reconciliation rather than breaking
    // a saved document. The lookup is scoped to this generated ID and actor.
    if (!saved) {
      try {
        const retained = await prisma.$transaction(async tx => {
          // Wait for any earlier admission transaction to finish before checking
          // absence. READ COMMITTED gives the lookup a fresh post-lock snapshot.
          await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${req.user!.organizationId} FOR UPDATE`;
          return tx.document.findFirst({
            where: { id: documentId, organizationId: req.user!.organizationId, uploadedById: req.user!.userId },
            select: { id: true, originalName: true, status: true, updatedAt: true },
          });
        }, { isolationLevel: "ReadCommitted", timeout: 5000, maxWait: 2000 });
        if (retained) return res.status(503).json({ success: false, code: "DOCUMENT_QUEUE_UNAVAILABLE",
          message: "File saved, but processing submission was not confirmed. Check its status.", data: documentView(retained, "UNAVAILABLE") });
      } catch {
        return res.status(503).json({ success: false, code: "UPLOAD_SAVE_UNCONFIRMED", message: "File saving could not be confirmed. Refresh the document library before uploading again." });
      }
      try { if (storageAttempted) await deleteStoredDocument(storagePath, organizationId); }
      catch { return res.status(503).json({ success: false, code: "UPLOAD_CLEANUP_UNCONFIRMED", message: "File cleanup could not be confirmed." }); }
    }
    if (error instanceof DocumentDeletionError && error.status === 403)
      return res.status(403).json({ success: false, code: "MEMBERSHIP_REQUIRED", message: "Current membership is required." });
    console.error("Upload document failed.");
    return res
      .status(500)
      .json({ success: false, message: "Failed to upload document" });
  }
};
