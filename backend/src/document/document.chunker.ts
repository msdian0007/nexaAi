const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

export interface DocumentChunkData {
  content: string;
  chunkIndex: number;
}

export const chunkText = (text: string): DocumentChunkData[] => {
  const cleanedText = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (!cleanedText) {
    return [];
  }

  const chunks: DocumentChunkData[] = [];

  let start = 0;
  let chunkIndex = 0;

  while (start < cleanedText.length) {
    let end = start + CHUNK_SIZE;

    if (end < cleanedText.length) {
      const lastSpace = cleanedText.lastIndexOf(" ", end);

      if (lastSpace > start) {
        end = lastSpace;
      }
    }

    const content = cleanedText.slice(start, end).trim();

    if (content) {
      chunks.push({
        content,
        chunkIndex,
      });

      chunkIndex++;
    }

    if (end >= cleanedText.length) {
      break;
    }

    start = end - CHUNK_OVERLAP;
  }

  return chunks;
};
