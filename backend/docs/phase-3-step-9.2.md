# Phase 3 — Step 9.2: Filtering weak search matches

## The problem

Nearest-neighbor search always finds the closest available text. That text
may still be unrelated to the question. Asking a leave-policy collection
about car insurance should not supply the leave policy as evidence for an answer.

## The concept

Each question and chunk has a 384-dimensional embedding from the same local
model. PostgreSQL compares their directions using cosine distance (`<=>`).
We calculate `similarity = 1 - distance`: higher values indicate closer meaning.
Similarity is not an answer-confidence percentage. A high-scoring chunk can
discuss the right topic while lacking the answer, or even contradict it.

`topK` controls the maximum number of chunks returned. `minSimilarity` controls
which chunks qualify. With `topK: 5`, one qualifying chunk means one result,
not one qualifying chunk plus four unrelated chunks.

## Choosing the initial cutoff

Small local-model check, using a leave-policy sentence and a cake-recipe sentence:

| Question | Leave policy | Cake recipe |
| --- | ---: | ---: |
| How much paid time off do employees get? | 0.594 | 0.105 |
| How many vacation days can I take? | 0.431 | 0.184 |
| How long should I bake a chocolate cake? | 0.086 | 0.807 |
| What does my car insurance cover? | 0.106 | -0.052 |
| How far is Jupiter from the sun? | 0.112 | 0.101 |

The default is **0.35**, which separates these examples. These five questions
are a sanity check, not a representative evaluation. Test more real questions,
paraphrases, ambiguous questions, and questions the documents cannot answer
before treating this as a production setting.

- Higher cutoff: fewer weak matches, but more useful evidence can be missed.
- Lower cutoff: more potential evidence, but more unrelated text can pass.

Cosine similarity can be negative. This API deliberately accepts cutoffs from
0 to 1. Even a cutoff of 0 still excludes negative-scoring matches.

## How the implementation works

1. `document.search.controller.ts` validates the request. Omitted
   `minSimilarity` uses 0.35; explicit zero is preserved. Strings, null, and
   out-of-range values return HTTP 400.
2. `document.search.ts` embeds the question. Its tenant-scoped SQL first selects
   completed documents with completed, nonzero embeddings.
3. `WHERE 1 - (embedding <=> query_vector) >= minSimilarity` excludes weak
   matches. All values are bound parameters, not concatenated SQL.
4. `ORDER BY` ranks remaining chunks and `LIMIT topK` caps the result count.
   Filtering uses the full score, not a rounded display value.
5. The response includes the applied cutoff and `hasMatches`. No qualifying
   chunks returns HTTP 200 with an empty list, because the search succeeded.
   Database/model failures still return HTTP 500, not a misleading empty search.

## Try the API

```http
POST /api/v1/documents/search
Authorization: Bearer <your-token>
Content-Type: application/json

{
  "query": "What does my car insurance cover?",
  "topK": 5,
  "minSimilarity": 0.35
}
```

If your organization's indexed documents have no qualifying match:

```json
{
  "success": true,
  "message": "No relevant information found",
  "data": {
    "query": "What does my car insurance cover?",
    "minSimilarity": 0.35,
    "hasMatches": false,
    "results": []
  }
}
```

This means **nothing qualified in the current indexed collection at this
cutoff**. It does not prove the answer does not exist. The same response is
used when no documents have finished indexing.

## Verification

From `backend`, build and then run the real-model search tests:

```powershell
npm.cmd run build
node --test tests/document.search.integration.test.cjs
```

Tests cover relevant paraphrases, unrelated queries, stricter and relaxed
cutoffs, the inclusive boundary, invalid inputs, empty collections, tenant
isolation, and unfinished content. They use isolated records and clean up
afterward. The database and local embedding model must be available.

This step only filters retrieved evidence. The later RAG stage must decide
whether that evidence actually supports an answer and cite its sources.
