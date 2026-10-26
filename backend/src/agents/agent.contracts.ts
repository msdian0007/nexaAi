import type { answerDocumentQuestion } from '../rag/rag.service';

// These are contracts for future executors, not enabled tools or HTTP routes.
// Identity is supplied separately by authenticated server code, never by a model.
export type AgentContext = Readonly<{ userId: string; organizationId: string }>;

export const AGENT_TOOL_CATALOG = {
  knowledge_answer: {
    description: 'Answer one question using the current organization\'s indexed documents.',
    effect: 'read', permission: 'current_member', requiresConfirmation: false, implementationStep: '12.2',
  },
  document_counts: {
    description: 'Count current organization documents by saved database processing status.',
    effect: 'read', permission: 'current_member', requiresConfirmation: false, implementationStep: '12.3',
  },
  retry_document: {
    description: 'Request processing of one eligible saved document after user confirmation.',
    effect: 'queue_write', permission: 'current_member', requiresConfirmation: true, implementationStep: '12.5',
  },
} as const;

export type AgentToolCall =
  | { tool: 'knowledge_answer'; input: { question: string } }
  | { tool: 'document_counts'; input: Record<string, never> }
  | { tool: 'retry_document'; input: { documentId: string } };

// Reuse the existing validated RAG result instead of inventing a competing
// answer/citation shape. This type-only import does not load the provider or DB.
export type KnowledgeAnswerResult = Awaited<ReturnType<typeof answerDocumentQuestion>>;
export type DocumentCountsResult = {
  asOf: string;
  total: number;
  byStatus: { UPLOADED: number; PROCESSING: number; COMPLETED: number; FAILED: number };
};
export type RetryDocumentResult = { documentId: string; state: 'accepted' };
export type AgentToolResult =
  | { tool: 'knowledge_answer'; data: KnowledgeAnswerResult }
  | { tool: 'document_counts'; data: DocumentCountsResult }
  | { tool: 'retry_document'; data: RetryDocumentResult };

// A model can propose a tool or ask for clarification, but cannot grant access.
// Begin with one tool per request; no autonomous multi-tool execution loop.
export type AgentDecision =
  | { kind: 'tool'; call: AgentToolCall }
  | { kind: 'clarification'; question: string }
  | { kind: 'unsupported'; message: string };

export class AgentContractError extends Error {
  readonly code = 'INVALID_TOOL_CALL';
  constructor() {
    // Never echo model arguments, document text, or SQL into an error response.
    super('The proposed tool or its arguments are not supported.');
    this.name = 'AgentContractError';
  }
}

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

export function parseAgentToolCall(value: unknown): AgentToolCall {
  if (!record(value) || !exactKeys(value, ['tool', 'input']) || !record(value.input)) {
    throw new AgentContractError();
  }
  const input = value.input;
  switch (value.tool) {
    case 'knowledge_answer': {
      if (!exactKeys(input, ['question']) || typeof input.question !== 'string') throw new AgentContractError();
      const question = input.question.trim();
      if (!question || question.length > 1000) throw new AgentContractError();
      return { tool: 'knowledge_answer', input: { question } };
    }
    case 'document_counts':
      // No SQL, table names, tenant IDs, arbitrary filters, or unbounded row lists.
      if (!exactKeys(input, [])) throw new AgentContractError();
      return { tool: 'document_counts', input: {} };
    case 'retry_document':
      if (!exactKeys(input, ['documentId']) || typeof input.documentId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.documentId)) {
        throw new AgentContractError();
      }
      // Parsing is NOT confirmation or authorization. The executor must later
      // verify a server-bound confirmation, current membership, scope and state.
      return { tool: 'retry_document', input: { documentId: input.documentId } };
    default:
      throw new AgentContractError();
  }
}
