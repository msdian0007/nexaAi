import fs from "fs/promises";
import path from "path";
import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

export const extractTextFromDocument = async (
  filePath: string,
  mimeType: string
): Promise<string> => {
  const absolutePath = path.resolve(filePath);

  // TXT
  if (mimeType === "text/plain") {
    return fs.readFile(absolutePath, "utf-8");
  }

  // PDF
  if (mimeType === "application/pdf") {
    const buffer = await fs.readFile(absolutePath);

    const parser = new PDFParse({
      data: buffer,
    });

    try {
      const result = await parser.getText();

      return result.text;
    } finally {
      await parser.destroy();
    }
  }

  // DOCX
  if (
    mimeType ===
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const result = await mammoth.extractRawText({
      path: absolutePath,
    });

    return result.value;
  }

  throw new Error(`Unsupported document type: ${mimeType}`);
};