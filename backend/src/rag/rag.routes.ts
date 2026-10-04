import { Router } from "express";
import { authenticate } from "../auth/auth.middleware";
import { queryDocuments } from "./rag.controller";

const router = Router();
router.post("/query", authenticate, queryDocuments);
export default router;
