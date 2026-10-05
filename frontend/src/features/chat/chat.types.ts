export interface AnswerSource {
  sourceId: string;
  documentId: string;
  chunkId: string;
  documentName: string;
  chunkIndex: number;
  similarity: number;
}

export interface ChatAnswer {
  question: string;
  status: 'answered' | 'insufficient_information' | 'conflicting_evidence';
  answer: string;
  citations: string[];
  sources: AnswerSource[];
}

// TypeScript types disappear at runtime. Check the API shape before rendering it,
// so an unexpected response becomes a recoverable error rather than a broken page.
export function parseChatAnswer(value: unknown, question: string): ChatAnswer {
  const data = value as ChatAnswer | null;
  if (!data || data.question !== question ||
      !['answered', 'insufficient_information', 'conflicting_evidence'].includes(data.status) ||
      typeof data.answer !== 'string' || !data.answer.trim() || data.answer.length > 8000 ||
      !Array.isArray(data.citations) || !Array.isArray(data.sources) ||
      data.citations.some(id => typeof id !== 'string' || !/^S[1-9]\d*$/.test(id)) ||
      new Set(data.citations).size !== data.citations.length ||
      data.sources.length !== data.citations.length ||
      data.sources.some(source => !source || typeof source.documentName !== 'string' ||
        typeof source.documentId !== 'string' || typeof source.chunkId !== 'string' ||
        !Number.isInteger(source.chunkIndex) || source.chunkIndex < 0 || !Number.isFinite(source.similarity) ||
        !data.citations.includes(source.sourceId)) ||
      new Set(data.sources.map(source => source.sourceId)).size !== data.sources.length) {
    throw new Error('Unexpected answer response');
  }
  // The backend owns factual/citation validation; these checks catch incomplete
  // response mappings before the UI could show an answer without its references.
  const inline = new Set([...data.answer.matchAll(/\[(S[1-9]\d*)\]/g)].map(match => match[1]));
  if (inline.size !== data.citations.length || data.citations.some(id => !inline.has(id)) ||
      (data.status === 'answered' && data.citations.length === 0) ||
      (data.status === 'conflicting_evidence' && data.citations.length < 2)) {
    throw new Error('Incomplete answer citations');
  }
  return data;
}
