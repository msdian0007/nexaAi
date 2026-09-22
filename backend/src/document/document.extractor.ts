import fs from "fs/promises";
import path from "path";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";

export const extractTextFromDocument = async (
  filePath: string,
  mimeType: string
): Promise<string> => {
  const absolutePath = path.resolve(filePath);

  if (mimeType === "text/plain") {
    return fs.readFile(absolutePath, "utf-8");
  }

  if (mimeType === "application/pdf") {
    const buffer = await fs.readFile(absolutePath);

    const result = await pdfParse(buffer);

    return result.text;
  }

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