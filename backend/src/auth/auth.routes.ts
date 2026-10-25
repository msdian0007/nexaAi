import { Router } from "express";
import { login, register, registerInvitation } from "./auth.controller";

const router = Router();

router.post("/register", register);
router.post("/register-invitation", registerInvitation);
router.post("/login", login);

export default router;
