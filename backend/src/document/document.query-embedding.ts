import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { generateEmbedding } from "./document.embedding";
import { EMBEDDING_PROFILE } from "./document.embedding.profile";

const PROFILE = JSON.stringify(EMBEDDING_PROFILE);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createQueryEmbeddingCache(options: {
  generate?: (text: string) => Promise<number[]>;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  maxPending?: number;
} = {}) {
  const generate = options.generate ?? ((text: string) => generateEmbedding(text));
  const now = options.now ?? (() => performance.now());
  const ttlMs = options.ttlMs ?? 5 * 60000;
  const maxEntries = options.maxEntries ?? 128;
  const maxPending = options.maxPending ?? 16;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 5 * 60000 ||
      !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 128 ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 16)
    throw new Error("Invalid query embedding cache configuration.");
  const entries = new Map<string, { vector: number[]; expiresAt: number }>();
  const pending = new Map<string, Promise<number[]>>();

  async function compute(query: string) {
    const vector = await generate(query);
    // Refuse invalid vectors before storing them. Never cache failures or let a
    // caller mutate a vector shared with another request.
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_PROFILE.dimensions ||
        !vector.every(Number.isFinite) || !vector.some(value => value !== 0))
      throw new Error("Invalid query embedding.");
    return [...vector];
  }

  return {
    async get(organizationId: string, query: string): Promise<number[]> {
      if (!UUID.test(organizationId) || typeof query !== "string" || !query.trim() || query.length > 1000)
        throw new Error("Invalid query embedding input.");
      // Keep the exact query bytes: no lowercasing, semantic guesses or hidden
      // normalization. The hash avoids retaining plain question text as a key.
      const key = createHash("sha256").update(JSON.stringify([organizationId, PROFILE, query])).digest("hex");
      const time = now();
      for (const [storedKey, entry] of entries) if (entry.expiresAt <= time) entries.delete(storedKey);
      const hit = entries.get(key);
      if (hit) {
        // Map insertion order implements least-recently-used eviction. Reads do
        // not extend the five-minute expiry from the original successful fill.
        entries.delete(key); entries.set(key, hit);
        return [...hit.vector];
      }
      const inFlight = pending.get(key);
      if (inFlight) return [...await inFlight];
      // Bound the bookkeeping for distinct simultaneous misses. A full pending
      // map bypasses caching; this optional optimization never rejects valid work.
      if (pending.size >= maxPending) return compute(query);
      const work = compute(query).then(vector => {
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
        entries.set(key, { vector, expiresAt: now() + ttlMs });
        return vector;
      }).finally(() => { pending.delete(key); });
      pending.set(key, work);
      return [...await work];
    },
  };
}

// Process-local, disposable optimization: no Redis keys, document passages,
// model answers, roles or membership decisions are stored in this cache.
const queryEmbeddings = createQueryEmbeddingCache();
export const getQueryEmbedding = (organizationId: string, query: string) => queryEmbeddings.get(organizationId, query);
