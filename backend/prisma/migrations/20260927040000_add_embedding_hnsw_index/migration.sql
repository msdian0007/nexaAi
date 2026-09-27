CREATE INDEX "DocumentChunk_embedding_idx"
ON "DocumentChunk"
USING hnsw ("embedding" vector_cosine_ops);
