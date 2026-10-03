# Phase 3 — Step 9.3: Context construction

Search retrieves relevant chunks. Context construction packages selected chunks
as evidence for a future answer-generation call. This step does not call an LLM.

## Why a separate builder?

The search response contains database metadata and scores. A language model needs
the actual excerpts and a consistent way to refer to their sources. Sending every
match without a budget can also produce an unnecessarily large prompt.

`document.context.ts` is a pure function: it accepts ranked search results and
returns context without touching the database, model, or input array. The search
controller calls it after tenant filtering and similarity filtering.

## Evidence and citations

The returned `context.text` is a JSON string representing entries such as:

```json
[
  { "sourceId": "S1", "content": "Employees receive 18 days of annual leave." }
]
```

`context.sources` maps `S1` to the document ID, filename, chunk ID, chunk index,
and similarity score. A later generated answer can cite `[S1]`, and the backend
can resolve that label to a document. Labels are local to this response, not
permanent identifiers. Chunk indexes are not page numbers.

The builder preserves relevance order and includes each chunk ID once. It trims
outer whitespace and skips empty excerpts. Identical text from different chunk
IDs keeps both sources; overlapping chunks are not merged in this version.

## Size limit

The default maximum is 8,000 JavaScript string-length units (UTF-16 code units).
It counts the actual serialized evidence string, including labels, JSON syntax,
escaped quotes and line breaks. This is a practical initial character budget,
not a token count or a complete prompt budget. Source metadata, the question,
and future instructions are not counted in it.

For each result, the builder serializes a candidate containing the accepted
excerpts plus that result. If it fits, the excerpt and source metadata are added
together. If it does not fit, the whole chunk is skipped and later chunks are
considered. We do not cut an excerpt midway through a sentence or condition.

`omittedChunks` counts all retrieved entries not included: duplicates, empty
entries, and entries omitted for size. `charCount` reports the resulting length.

If no excerpts are included, `hasContext` is false, `text` is an empty string,
and `sources` is empty. Search `hasMatches` and context `hasContext` are different:
a search match may exist but be too large to include. The future generation
step must check `hasContext` before using the evidence.

## Inspect it in Postman

Use the existing `POST /api/v1/documents/search` endpoint with your Bearer token:

```json
{
  "query": "How many vacation days do employees receive?",
  "topK": 5,
  "minSimilarity": 0.35
}
```

Inspect `data.context.text`, `data.context.sources`, and `data.context.charCount`.
The existing `data.results` remains available. The API's outer JSON escapes the
inner JSON string; parsing `context.text` once gives the excerpt array.

## Evidence is not instructions

JSON encoding prevents quotes or fake source labels in document text from
changing the serialized structure. It does not prevent a language model from
being influenced by malicious text. The later generation step must treat these
excerpts as untrusted evidence, use separate instructions, and validate citations.
Source labels alone do not guarantee that an answer is supported by its sources.

## Verify

From `backend`:

```powershell
npm.cmd run build
node --test tests/document.context.test.cjs tests/document.search.integration.test.cjs
```

Unit tests cover source mapping, duplicate IDs, empty input, whole-chunk budget
boundaries, overflow, and JSON escaping. Integration tests verify that context
contains only the tenant-scoped, threshold-qualified search results.
