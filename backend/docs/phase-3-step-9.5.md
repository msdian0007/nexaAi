# Phase 3 — Step 9.5: Response and citation validation

## Why validate?

A prompt requests behavior; it does not enforce it. Model output is external
input. It may contain invalid JSON, extra prose, an unsupported status, or a
citation to a source that was never supplied.

`src/rag/rag.response.ts` validates a raw JSON string against the server-owned
source mapping for the exact evidence sent to the model. Never accept that
mapping from a client or from the model. The validator does not query the
database or establish organization ownership; retrieval already did that.

## Validation sequence

1. Require a string of at most 32,000 UTF-16 code units, then parse JSON.
2. Require exactly `status`, `answer`, and `citations`, with an allowed status.
3. Require a nonblank answer of at most 8,000 UTF-16 code units.
4. Require unique citation IDs such as `S1`, without brackets or leading zeros.
5. Extract inline labels such as `[S1]` from the answer. Square brackets are
   reserved for individual citation labels; multiple labels use `[S1][S2]`.
6. Reject any ID absent from the supplied source map.
7. Require the inline ID set to equal the citations-array ID set. Repeated
   inline references are allowed, but duplicate array entries are not.
8. Require at least one citation for `answered`, and two distinct citations for
   `conflicting_evidence`. An insufficient-information response may have zero
   citations or cite the supported portion of a partial answer.
9. Return the validated response plus copies of only the cited source records.

## Example

Given source `S1` mapped to a handbook chunk, this passes:

```json
{
  "status": "answered",
  "answer": "Full-time employees receive 18 days of annual leave. [S1]",
  "citations": ["S1"]
}
```

Changing the array to `["S2"]` fails because it disagrees with the inline label.
Changing both labels to `S99` fails if S99 was not supplied. An extra `sources`
field containing model-invented document metadata also fails: source records
are resolved by the application, not trusted from model output.

Malformed output throws `RagResponseValidationError` with a stable `code`.
The validator does not silently repair JSON, remove citations, or turn a failed
validation into an insufficient-information answer. A future generation service
must handle this error before sending an answer to the client. No public endpoint
or model call is added in this step.

## What this does not prove

An answer saying "999 days of leave [S1]" can pass if S1 is a valid source label.
The validator cannot establish that S1 actually states that entitlement. Likewise,
two cited sources do not prove there is a real conflict. Factual support, citation
placement, and completeness require separate evaluation of actual model answers.

It is also not an HTML sanitizer or a prompt-injection defense. Frontend rendering
and model behavior require their own controls. JSON parsing uses standard
JavaScript semantics, including the last value winning for duplicate JSON keys.

## Verify

From `backend`:

```powershell
npm.cmd run build
node --test tests/rag.response.test.cjs tests/rag.prompt.test.cjs tests/document.context.test.cjs
```

These are local tests using synthetic responses: no model API, credentials, or
database is required. They exercise valid answers, partial answers, conflicts,
invalid JSON and shapes, invented/mismatched citations, size limits, and fallback
compatibility. One test explicitly demonstrates the factual-support limitation.
