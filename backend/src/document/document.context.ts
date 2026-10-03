import type { SearchResult } from "./document.search";

export const MAX_CONTEXT_CHARS = 8000;

export const buildDocumentContext = (
  results: SearchResult[],
  maxChars: number = MAX_CONTEXT_CHARS,
) => {
  if (!Number.isInteger(maxChars) || maxChars < 2 || maxChars > MAX_CONTEXT_CHARS) {
    throw new Error(`Context budget must be an integer from 2 to ${MAX_CONTEXT_CHARS}`);
  }

  const seen = new Set<string>();
  const excerpts: { sourceId: string; content: string }[] = [];
  const sources: (Omit<SearchResult, "content"> & { sourceId: string })[] = [];
  let text = "";

  // Input is already ranked and tenant-filtered by searchDocumentChunks.
  for (const result of results) {
    if (seen.has(result.chunkId)) continue;
    seen.add(result.chunkId);
    const content = result.content.trim();
    if (!content) continue;

    const sourceId = `S${sources.length + 1}`;
    const excerpt = { sourceId, content };
    // Include JSON overhead and escaped characters in the actual text budget.
    const candidate = JSON.stringify([...excerpts, excerpt], null, 2);
    if (candidate.length > maxChars) continue;

    excerpts.push(excerpt);
    const { content: _content, ...metadata } = result;
    sources.push({ sourceId, ...metadata });
    text = candidate;
  }

  return {
    hasContext: sources.length > 0,
    text,
    sources,
    charCount: text.length,
    maxChars,
    omittedChunks: results.length - sources.length,
  };
};
