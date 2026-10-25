import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import { queryDocuments } from "./rag.controller";
import { conversationDelete, conversationList, conversationMessages } from '../conversation/conversation.controller';

const router = Router();
router.post("/query", authenticate, queryDocuments);
// History shares chat authentication; controllers also check current membership and owner.
router.get('/conversations', authenticate, conversationList);
router.get('/conversations/:conversationId/messages', authenticate, conversationMessages);
router.delete('/conversations/:conversationId', authenticate, conversationDelete);
export default router;
