import multer from "multer";
import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { RequestHandler, ErrorRequestHandler } from "express";
import type { AuthenticatedRequest } from "../auth/auth.middleware";
import { ApiInputError, UUID } from "../http/api.boundary";
import { requireProcessingMembership, DocumentDeletionError } from "./document.deletion";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const mimeByExtension: Record<string, string> = {
  ".txt": "text/plain", ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
const directory = (organizationId: string) => path.resolve("uploads", "documents", organizationId);

export async function removeUnacceptedUpload(req: AuthenticatedRequest) {
  if (!req.file || !req.user) return;
  const target = path.resolve(req.file.path);
  // Only remove this request's exact generated regular file, never a directory
  // or a user-supplied path. Saved records/uncertain queue submissions keep files.
  if (path.dirname(target) !== directory(req.user.organizationId) ||
    !/^[0-9a-f-]{36}\.(txt|pdf|docx)$/.test(path.basename(target))) throw new Error("Unsafe upload cleanup target");
  try {
    const info = await fs.lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe upload cleanup file");
    await fs.unlink(target);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

export const permitUpload: RequestHandler = async (request: AuthenticatedRequest, _res, next) => {
  try {
    if (Object.keys(request.query).length) throw new ApiInputError();
    if (!request.is("multipart/form-data")) throw new ApiInputError(415, "UNSUPPORTED_CONTENT_TYPE", "Use multipart/form-data with one document file.");
    // Do this before Multer writes bytes. A signed but removed member must not
    // create files or records; creation checks membership again under its lock.
    await requireProcessingMembership(request.user!.userId, request.user!.organizationId);
    return next();
  } catch (error) {
    if (error instanceof DocumentDeletionError) return next(new ApiInputError(403, "MEMBERSHIP_REQUIRED", "Current membership is required."));
    return next(error instanceof ApiInputError ? error : new ApiInputError(503, "UPLOAD_UNAVAILABLE", "Upload access could not be verified."));
  }
};
const storage = multer.diskStorage({
  destination: (request, _file, callback) => {
    const req = request as AuthenticatedRequest;
    const organizationId = req.user?.organizationId;
    if (!organizationId || !UUID.test(organizationId)) return callback(new Error("Invalid identity"), "");
    const root = directory(organizationId);
    void (async () => {
      await fs.mkdir(root, { recursive: true });
      for (const dir of [path.resolve("uploads"), path.resolve("uploads", "documents"), root]) {
        const info = await fs.lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe upload directory");
      }
      callback(null, root);
    })().catch(() => callback(new Error("Upload storage unavailable"), ""));
  },
  filename: (_req, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
export const receiveUpload = multer({ storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 100 },
  fileFilter: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    if (!file.originalname || file.originalname.length > 255 || /[\u0000-\u001f\u007f\\/]/.test(file.originalname) ||
      mimeByExtension[extension] !== file.mimetype)
      return callback(new ApiInputError(415, "UNSUPPORTED_FILE_TYPE", "Use a PDF, DOCX or TXT file with its matching content type."));
    callback(null, true);
  },
}).single("document");

export const inspectUpload: RequestHandler = async (request: AuthenticatedRequest, _res, next) => {
  try {
    if (!request.file) throw new ApiInputError(400, "MISSING_UPLOAD", "Choose one document file.");
    if (!request.file.size) throw new ApiInputError(400, "EMPTY_UPLOAD", "The file must contain content.");
    const buffer = await fs.readFile(request.file.path); // Multer already caps it at 10 MiB.
    let valid = false;
    if (request.file.mimetype === "text/plain") {
      try { valid = !buffer.includes(0) && !!new TextDecoder("utf-8", { fatal: true }).decode(buffer).trim(); }
      catch { valid = false; }
    } else if (request.file.mimetype === "application/pdf") valid = buffer.subarray(0, 5).toString("ascii") === "%PDF-";
    else valid = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    // PDF/ZIP signatures are admission checks. Full PDF/DOCX parsing still runs
    // in the worker; this does not certify safety, readability or valid Word XML.
    if (!valid) throw new ApiInputError(415, "INVALID_FILE_CONTENT", "The file content does not match the selected document format.");
    return next();
  } catch (error) {
    try { await removeUnacceptedUpload(request); }
    catch { return next(new ApiInputError(503, "UPLOAD_CLEANUP_UNCONFIRMED", "Upload was rejected but file cleanup could not be confirmed.")); }
    return next(error instanceof ApiInputError ? error : new ApiInputError(503, "UPLOAD_UNAVAILABLE", "The uploaded file could not be checked."));
  }
};

export const uploadError: ErrorRequestHandler = (error, _req, _res, next) => {
  if (error instanceof multer.MulterError) return next(new ApiInputError(
    error.code === "LIMIT_FILE_SIZE" ? 413 : 400,
    error.code === "LIMIT_FILE_SIZE" ? "UPLOAD_TOO_LARGE" : "INVALID_UPLOAD",
    error.code === "LIMIT_FILE_SIZE" ? "The file must be 10 MiB or smaller." : "Upload exactly one document file without additional fields.",
  ));
  if (/^(Multipart:|Unexpected end of (form|file))/.test(error?.message ?? ""))
    return next(new ApiInputError(400, "INVALID_UPLOAD", "Provide a complete multipart document upload."));
  return next(error);
};
