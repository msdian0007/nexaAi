import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import { requestFields } from "../http/api.boundary";
import { queryDocuments } from "./rag.controller";
import { conversationDelete, conversationList, conversationMessages } from '../conversation/conversation.controller';

const router = Router();
router.post("/query", authenticate, requestFields({ body: ["question", "conversationId", "topK", "minSimilarity"], required: ["question"] }), queryDocuments);
// History shares chat authentication; controllers also check current membership and owner.
router.get('/conversations', authenticate, requestFields({ query: ["limit", "cursor"] }), conversationList);
router.get('/conversations/:conversationId/messages', authenticate, requestFields({ query: ["limit", "cursor"], ids: ["conversationId"] }), conversationMessages);
router.delete('/conversations/:conversationId', authenticate, requestFields({ ids: ["conversationId"] }), conversationDelete);
export default router;
