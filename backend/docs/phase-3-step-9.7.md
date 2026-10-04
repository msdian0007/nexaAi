# Phase 3 — Step 9.7: Ask a question through the HTTP API

## What this step connects

Earlier steps built retrieval, context, prompts, answer validation and the Gemini adapter separately. This step connects them behind `POST /api/v1/chat/query`, which a frontend or Postman can call.

1. Authentication verifies the Bearer token. The organization ID comes from its signed claims, never the request body.
2. The controller validates the question and search options before doing expensive work.
3. The service embeds the question locally and searches completed chunks belonging to that organization.
4. The context builder selects passages within its 8,000-character budget and assigns labels such as S1.
5. With no usable context, generation returns a fixed insufficient-information answer without contacting Gemini.
6. Otherwise, Gemini receives the question and selected evidence. Its response must pass the existing JSON and citation validator.
7. The API returns the answer and metadata for cited sources. Document IDs and filenames come from the server's source map, not from Gemini.

Retrieval-Augmented Generation (RAG) means retrieving evidence before asking a model to generate an answer. The model is not trained on the uploaded documents; selected excerpts are supplied with each question.

## Try it in Postman

Start the backend using `npm run dev` from `backend`. Log in using the existing authentication endpoint and use its access token. Upload and successfully process the sample handbook in the same organization first.

Method: `POST`

URL: `http://localhost:5000/api/v1/chat/query` (adjust if PORT differs)

Authorization: Bearer Token, containing your login token.

Body: raw JSON; Content-Type: application/json

```json
{
  "question": "How many days of annual leave do full-time employees receive?"
}
```

Optional `topK` defaults to 5 and accepts integers 1–10. Optional `minSimilarity` defaults to 0.35 and accepts numbers 0–1. Similarity is a retrieval score, not a probability that an answer is correct. Lowering the threshold can admit irrelevant evidence.

The successful response has `success: true` and `data` containing:

- `question`: the trimmed question.
- `status`: answered, insufficient_information, or conflicting_evidence.
- `answer`: text with inline source labels such as [S1].
- `citations`: the labels used in the answer.
- `sources`: metadata including sourceId, chunkId, documentId, documentName, chunkIndex and similarity for cited passages.

The handbook answer should mention 18 days, subject to the retrieved evidence. Generated wording can vary. Ask an unrelated question, such as the distance to Jupiter, to exercise the no-evidence path.

The earlier `/api/v1/documents/search` endpoint accepts `query` and returns matching passages. This endpoint accepts `question` and returns a generated, validated answer.

## Why there are three new modules

`rag.routes.ts` connects the URL and authentication middleware. `rag.controller.ts` handles HTTP input and errors. `rag.service.ts` coordinates retrieval, context and generation. This keeps the core sequence separate from HTTP concerns and reuses the existing components.

## Error behavior

| HTTP status | Meaning |
| --- | --- |
| 200 | Processing succeeded, including insufficient information or conflicting evidence |
| 400 | Invalid question or search options |
| 401 | Invalid/missing login token or organization context |
| 422 | Provider blocked generation |
| 502 | Invalid answer, incomplete output or rejected provider request |
| 503 | Provider unavailable, quota exhausted, or provider configuration/authentication issue |
| 504 | Provider timeout |
| 500 | Unexpected query failure |

A Gemini authentication failure is 503 rather than 401: the server's provider credential failed, not the user's login token. Errors expose stable public codes and generic messages. Logs omit raw prompts, document excerpts, keys and provider response bodies. There are no automatic generation retries.

## Verification and limits

After building, run:

```powershell
npm.cmd run build
node --test tests/rag.query.integration.test.cjs
node --test tests/document.context.test.cjs tests/rag.prompt.test.cjs tests/rag.response.test.cjs tests/rag.generation.test.cjs tests/gemini.provider.test.cjs
```

The HTTP integration suite uses the configured development/test PostgreSQL database, creates isolated fixture tenants and removes them afterward. It exercises real JWT authentication, embeddings and SQL retrieval, with controlled Gemini replies. It verifies tenant isolation, no-context skipping, input validation, citation rejection and provider error handling. It does not make live Gemini requests. The preceding step separately verified live Gemini connectivity.

Citation validation ensures references belong to the supplied context; it cannot prove every generated claim follows from those passages. This endpoint answers one question at a time. Chat history, streaming, frontend chat, and evaluation of real generated answers remain separate work.

Next: Step 9.8, evaluate the complete flow on supported, unrelated, partially supported and conflicting questions before moving to the next phase.
