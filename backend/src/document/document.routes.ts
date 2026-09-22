import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";

import { authenticate } from "../auth/auth.middleware";
import { uploadDocument } from "./document.controller";

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req: any, _file, cb) => {
    const organizationId = req.user?.organizationId;

    if (!organizationId) {
      return cb(new Error("Organization ID is required"), "");
    }

    const uploadDir = path.join(
      process.cwd(),
      "uploads",
      "documents",
      organizationId
    );

    fs.mkdirSync(uploadDir, {
      recursive: true,
    });

    cb(null, uploadDir);
  },

  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(
      Math.random() * 1e9
    )}${path.extname(file.originalname)}`;

    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,

  limits: {
    fileSize: 10 * 1024 * 1024,
  },

  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "text/plain",
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only PDF, DOCX and TXT files are allowed"));
    }
  },
});

router.post(
  "/upload",
  authenticate,
  upload.single("document"),
  uploadDocument
);

export default router;