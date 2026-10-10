export class HistoryInputError extends Error {}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value !== 'string' || !/^[1-9]\d?$/.test(value) || Number(value) > 50) {
    throw new HistoryInputError('limit must be an integer from 1 to 50');
  }
  return Number(value);
}

// Cursors describe an ordering boundary, not authorization. Every database query
// still filters by the signed owner/organization even if a client edits a cursor.
export const encodeCursor = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HistoryInputError('Invalid pagination cursor');
  }
  try {
    const data: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data as Record<string, unknown>;
  } catch { throw new HistoryInputError('Invalid pagination cursor'); }
}

export function conversationCursor(value: unknown) {
  const data = decodeCursor(value);
  if (!data) return undefined;
  if (data.kind !== 'conversations' || typeof data.id !== 'string' || !UUID.test(data.id) ||
      typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt)) ||
      new Date(data.updatedAt).toISOString() !== data.updatedAt) {
    throw new HistoryInputError('Invalid conversation cursor');
  }
  return { id: data.id, updatedAt: new Date(data.updatedAt) };
}

export function messageCursor(value: unknown, conversationId: string) {
  const data = decodeCursor(value);
  if (!data) return undefined;
  // Bind message positions to a conversation so accidentally reusing another
  // conversation's cursor cannot silently skip this conversation's opening messages.
  if (data.kind !== 'messages' || data.conversationId !== conversationId ||
      typeof data.sequence !== 'number' || !Number.isInteger(data.sequence) ||
      data.sequence < 0 || data.sequence > 2147483647) {
    throw new HistoryInputError('Invalid message cursor');
  }
  return data.sequence;
}
