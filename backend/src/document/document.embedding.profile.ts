// Share the exact inference settings with the query cache. Bump version if text
// preprocessing changes; a different model/profile must never reuse old vectors.
export const EMBEDDING_PROFILE = Object.freeze({
  model: "Xenova/all-MiniLM-L6-v2",
  pooling: "mean" as const,
  normalize: true as const,
  dimensions: 384,
  version: 1,
});
