# Phase 3 — Step 9.8: Evaluate real answers

## Why this step exists

An integration test with a controlled model reply can prove that code handles that reply correctly. It cannot show whether Gemini actually follows the evidence. This evaluation sends fictional questions and excerpts through the authenticated HTTP endpoint and inspects the real answers.

RAG quality depends on two separate things: retrieval must find the right evidence, and generation must use that evidence faithfully. The report records the evidence sent to Gemini as well as its validated answer, so a failure can be traced to the appropriate stage.

## Cases and expected behavior

| Case | Fictional evidence | Expected behavior |
| --- | --- | --- |
| Supported | Full-time employees receive 18 annual leave days | Answer 18 days, cite the policy, status answered |
| Unrelated | Leave policy; question asks about Jupiter | Fixed insufficient-information response, no Gemini call |
| Partial | Leave allowance exists; carry-over rules are absent | Give 18 days with a citation, explain missing carry-over information, status insufficient_information |
| Conflicting | One policy says 18 days; another says 25 | Explain the disagreement, cite both, status conflicting_evidence |

A different organization contains a highly relevant 99-day policy. Each request also supplies that organization's ID in its body. The endpoint must continue using the signed token's organization. An evaluation-only guard blocks any unexpected excerpt before it can be sent to Gemini.

## Run the evaluation

Use the configured development/test PostgreSQL database and a configured Gemini key. From `backend`:

```powershell
npm.cmd run build
node scripts/evaluate-rag.cjs
```

Wait for the build to finish before running the second command. This is an opt-in live evaluation, separate from ordinary tests. A successful run makes three Gemini requests and one local no-evidence request. It uses the configured model and API quota; it does not change billing or model settings. Provider errors stop the run without automatic retries.

The script starts an isolated server on a temporary localhost port, uses temporary signed tokens, creates fictional indexed documents and embeddings, and cleans up its fixture tenants afterward. It never reads real users' documents. Tokens and API keys are excluded from output.

The JSON report at `backend/docs/rag-evaluation-latest.json` is overwritten on each run. It includes timestamps, configured model, fictional evidence, HTTP responses, checks, provider-call counts and cleanup outcome. Exit code 0 means all four cases passed the automated checks and cleanup completed. Any failure gives a nonzero exit code.

## How to interpret results

Automated checks cover expected status, key numbers, citation/source counts, source ownership and whether Gemini was called. They intentionally do not compare entire answer strings: valid model wording varies.

Read the actual answers too. For the partial case, verify the answer admits that carry-over is unknown rather than inventing a rule. For the conflict case, verify it does not pick a preferred policy without evidence. Check that each citation supports its associated claim, including conditions such as full-time employment and per-calendar-year allowances.

Passing this small evaluation is evidence about these four cases on this run, not a general accuracy score or proof against hallucination. The runner seeds completed indexed chunks directly; it tests the question-to-answer flow, not uploading/parsing/chunking. The existing document pipeline test covers that separate path. Chat history, UI, production load and comprehensive adversarial evaluation are outside this step.

## Current execution result — 2026-10-04

The TypeScript build and runner syntax check passed. The initial sandbox attempt could not reach Gemini. Two subsequent network-authorized attempts reached the provider but received server-side failures, classified by the adapter as UNAVAILABLE. On both attempts, the first case retrieved the expected 18-day passage, NexaAI returned HTTP 503 with GENERATION_UNAVAILABLE, and fixture cleanup completed.

No generated answer was available to review in those initial attempts. The runner stopped at that provider failure, so the remaining cases were not executed in those runs.

## Resolution — 2026-10-04

The opt-in `node scripts/diagnose-gemini.cjs` script successfully listed available models using the existing key and generated a fictional answer using gemini-3.8-flash. A subsequent full evaluation passed supported and unrelated questions but failed on the partial question with UNAVAILABLE. This demonstrates intermittent success; it does not establish the underlying cause of the provider failures.

Testing `node scripts/diagnose-gemini.cjs gemini-3.1-flash-lite` succeeded. The complete four-case evaluation then passed with that model: three real generation requests, no generation for the unrelated question, correct source mapping and completed fixture cleanup. The actual answers were reviewed: 18 days with the full-time/calendar-year conditions; no invented carry-over rule; both conflicting allowances with their corresponding citations and no unsupported preference.

The local backend `.env` now sets `GEMINI_MODEL=gemini-3.1-flash-lite`. Restart the backend to load this setting. No API key change or production code change was required. The source-code fallback remains gemini-3.8-flash, so other environments should explicitly set the tested model too. Google lists a free tier for Gemini 3.1 Flash-Lite at https://ai.google.dev/gemini-api/docs/pricing; actual account quota and billing tier still apply.

Step 9.8 passed this small live evaluation. The latest JSON report contains the successful run and model. This is a verified workaround, not a guarantee of future availability. A bounded retry policy with backoff can be evaluated separately if intermittent errors persist; automatic retries are not enabled by this change.
