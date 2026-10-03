const { test } = require("node:test");
const assert = require("node:assert/strict");
const { validateRagResponse, RagResponseValidationError } = require("../dist/src/rag/rag.response");
const { buildRagPrompt } = require("../dist/src/rag/rag.prompt");
const { buildDocumentContext } = require("../dist/src/document/document.context");

const sources = ["S1", "S2"].map(sourceId => ({
  sourceId, chunkId: `chunk-${sourceId}`, documentId: `document-${sourceId}`,
  documentName: "handbook.txt", chunkIndex: 0, similarity: 0.8,
}));
const response = (changes = {}) => ({ status: "answered", answer: "Annual leave is 18 days. [S1]", citations: ["S1"], ...changes });
const validate = object => validateRagResponse(JSON.stringify(object), sources);
const rejects = (object, code) => assert.throws(() => validate(object), error => error instanceof RagResponseValidationError && error.code === code);

test("accepts a cited answer and resolves only cited sources without sharing mutable references", () => {
  const input = response();
  const output = validate(input);
  assert.deepEqual(output.sources, [sources[0]]);
  assert.equal(output.answer, input.answer);
  output.sources[0].documentName = "changed";
  output.citations.push("S2");
  assert.equal(sources[0].documentName, "handbook.txt");
  assert.deepEqual(input.citations, ["S1"]);
});

test("allows repeated inline citations, with a unique citation list in any order", () => {
  const output = validate(response({ answer: "First [S1]. Second [S2]. Again [S1].", citations: ["S2", "S1"] }));
  assert.deepEqual(output.sources.map(source => source.sourceId), ["S2", "S1"]);
});

test("accepts the no-context fallback and a cited partial answer", () => {
  const fallback = buildRagPrompt("Question?", buildDocumentContext([])).response;
  assert.deepEqual(validateRagResponse(JSON.stringify(fallback), []), { ...fallback, sources: [] });
  assert.equal(validate(response({ status: "insufficient_information", answer: "Leave is 18 days [S1], but carryover is not specified." })).status, "insufficient_information");
});

test("requires two distinct sources for a conflict and at least one for an answer", () => {
  assert.equal(validate(response({ status: "conflicting_evidence", answer: "Policies disagree: 18 days [S1] and 20 days [S2].", citations: ["S1", "S2"] })).status, "conflicting_evidence");
  rejects(response({ status: "conflicting_evidence" }), "INVALID_STATUS_CITATIONS");
  rejects(response({ answer: "18 days.", citations: [] }), "INVALID_STATUS_CITATIONS");
});

test("rejects malformed JSON, Markdown fences, commentary, and oversized raw input", () => {
  for (const raw of [undefined, {}, "", "{", '```json\n{}\n```', 'Here is the answer: {}', "x".repeat(32001)]) {
    assert.throws(() => validateRagResponse(raw, sources), error => error.code === "INVALID_JSON");
  }
});

test("rejects wrong object shapes, extra fields, and unsupported statuses", () => {
  for (const value of [null, [], 2, "text", {}, { status: "answered", answer: "Text" }, response({ confidence: 0.9 }), response({ status: "maybe" }), response({ status: null })]) {
    rejects(value, "INVALID_STRUCTURE");
  }
});

test("rejects missing, blank, non-string, and overlong answers", () => {
  for (const answer of [null, 18, "", "  ", "x".repeat(8001)]) rejects(response({ answer }), "INVALID_ANSWER");
});

test("rejects duplicate, non-string, and malformed citation IDs", () => {
  for (const citations of [null, "S1", [1], ["S1", "S1"], ["[S1]"], ["s1"], ["S0"], ["S01"]]) {
    rejects(response({ citations }), "INVALID_CITATIONS");
  }
  for (const answer of ["Text [S1, S2]", "Text [s1]", "Text [S01]", "Text [S1", "Text S1]"]) {
    rejects(response({ answer }), "INVALID_CITATIONS");
  }
});

test("rejects invented source labels and inconsistent inline/list citations", () => {
  rejects(response({ answer: "Text [S99]", citations: ["S99"] }), "UNKNOWN_CITATION");
  rejects(response({ answer: "Text [S99]" }), "UNKNOWN_CITATION");
  rejects(response({ answer: "Text [S2]" }), "CITATION_MISMATCH");
  rejects(response({ citations: ["S1", "S2"] }), "CITATION_MISMATCH");
  rejects(response({ citations: [] }), "CITATION_MISMATCH");
  assert.throws(() => validateRagResponse(JSON.stringify(response()), []), error => error.code === "UNKNOWN_CITATION");
});

test("rejects ambiguous source maps", () => {
  for (const map of [[sources[0], sources[0]], [{ ...sources[0], sourceId: "fake" }]]) {
    assert.throws(() => validateRagResponse(JSON.stringify(response()), map), error => error.code === "INVALID_SOURCE_MAP");
  }
});

test("structural validation does not claim to detect an unsupported factual answer", () => {
  // A real S1 label is not proof that S1 supports this number.
  const output = validate(response({ answer: "Annual leave is 999 days. [S1]" }));
  assert.equal(output.status, "answered");
});
