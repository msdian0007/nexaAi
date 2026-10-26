import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import { deleteDocument, documentLibrary, documentStatus, reprocessDocument, uploadDocument } from "./document.controller";
import { searchDocuments } from "./document.search.controller";
import { requestFields, apiError } from "../http/api.boundary";
import { permitUpload, receiveUpload, inspectUpload, uploadError } from "./document.upload";

const router = Router();
router.get("/", authenticate, requestFields({ query: ["limit", "cursor"] }), documentLibrary);
router.delete("/:documentId", authenticate, requestFields({ ids: ["documentId"] }), deleteDocument);
router.post("/search", authenticate, requestFields({ body: ["query", "topK", "minSimilarity"], required: ["query"] }), searchDocuments);
router.get("/:documentId/status", authenticate, requestFields({ ids: ["documentId"] }), documentStatus);
router.post("/:documentId/reprocess", authenticate, requestFields({ ids: ["documentId"] }), reprocessDocument);
router.post("/upload", authenticate, permitUpload, receiveUpload, inspectUpload, uploadDocument);
router.use(uploadError, apiError);
export default router;
