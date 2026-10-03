# Phase 3 — Step 9.6: Gemini integration

## What runs where?

Embedding generation and semantic search remain local. Gemini is the hosted
answer-generation model. It receives the prepared instructions, question, and
selected evidence text, not database credentials or the complete document store.
Source metadata remains in our backend for citation resolution.

The flow is:

```text
question + tenant-scoped context
    -> buildRagPrompt
    -> empty evidence: return the insufficient-information fallback
    -> otherwise: Gemini REST adapter
    -> validateRagResponse
    -> answer + resolved sources
```

`rag.generation.ts` owns the common flow. `gemini.provider.ts` translates the
prepared messages into a Gemini request. Separating them lets us test failures
without calling an external model or change providers without rewriting retrieval.

## Request and response handling

The adapter uses Node's built-in fetch, so no additional package is required.
It sends application rules as `systemInstruction`, question/evidence as user
content, and the key in `x-goog-api-key`. The endpoint is fixed to Google's API;
redirects are rejected. Keys are not placed in URLs or error messages.

The request uses `generationConfig.responseFormat.text` with JSON MIME type and
a schema requiring `status`, `answer`, and `citations`. Structured output helps
with format; our validator still checks source IDs and citation consistency.

A request has a 30-second timeout covering connection and body reading, one
candidate, and a 4,096 output-token cap. This output limit is not a character
count or a guaranteed monetary budget. Thinking can consume model output budget.
If the model stops for a token limit rather than normal completion, the adapter
rejects the incomplete answer even if the partial text looks like valid JSON.

Prompt blocks, non-normal completion, missing text, malformed envelopes, network
failures, and HTTP errors are surfaced separately. Thought parts are not returned
as answer text. Provider error bodies are not propagated to callers.

## Configure the key locally

Append the settings from `.env.gemini.example` to `backend/.env`. Preserve your
existing database and JWT settings:

```env
GEMINI_API_KEY=your-key-from-google-ai-studio
GEMINI_MODEL=gemini-3.8-flash
```

Do not paste the populated key into chat or commit `.env`. The backend loads
dotenv at application startup; the standalone smoke script loads it explicitly.
Configuration is read when generation is called, so missing Gemini credentials
do not prevent the no-evidence fallback.

Google's pricing page lists a free tier for the default model at implementation
time. Actual free availability depends on your project, model access, and quota.
Confirm the project is on the free tier in AI Studio before a live request. Code
cannot enforce Google's billing tier. Changing GEMINI_MODEL can change pricing.
There are no automatic retries, model substitutions, or paid-provider fallbacks.

Free-tier content can be used to improve Google's products under its applicable
terms. Use fictional/non-sensitive documents for this demo.

## Verify without using quota

From `backend`:

```powershell
npm.cmd run build
node --test tests/gemini.provider.test.cjs tests/rag.generation.test.cjs tests/rag.response.test.cjs tests/rag.prompt.test.cjs tests/document.context.test.cjs
```

These tests stub only the HTTP transport, exercising the actual request builder,
response handling, generation flow, and validation. They make no network calls.

## One live smoke test

After adding the key and checking the free tier:

```powershell
node scripts/test-gemini.cjs
```

This sends one question and one fictional leave-policy excerpt, then prints the
validated answer and source mapping. It does not upload existing tenant data or
require a database. A successful result should cite S1 and report 18 annual leave
days for full-time employees. Manually check that the answer follows the evidence.

| Error code | Meaning/action |
| --- | --- |
| CONFIGURATION | Add the key or correct the model setting |
| AUTHENTICATION | Check key restrictions and project permissions |
| MODEL_UNAVAILABLE | Verify the model is available to your project |
| QUOTA | Check free-tier limits; wait rather than automatically upgrading |
| TIMEOUT / NETWORK / UNAVAILABLE | Request failed; retry manually after checking the cause |
| REQUEST_REJECTED | Check API request/model compatibility |
| BLOCKED | Provider did not allow the prompt or answer |
| INCOMPLETE_RESPONSE | Generation did not finish normally |
| INVALID_RESPONSE | Provider returned an unusable response envelope |
| UNKNOWN_CITATION or other validation error | Returned text failed our answer validator |

The public RAG endpoint belongs to Step 9.7 and is not added here. Live integration
cannot be verified until the API key is configured.

Official references checked during implementation:

- [GenerateContent REST reference](https://ai.google.dev/api/generate-content)
- [Structured output guide](https://ai.google.dev/gemini-api/docs/structured-output)
- [Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [API keys](https://aistudio.google.com/apikey)
