const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildDocumentContext } = require("../dist/src/document/document.context");
const { generateRagAnswer } = require("../dist/src/rag/rag.generation");
const context = () => buildDocumentContext([{
  chunkId: "chunk-1", documentId: "document-1", documentName: "handbook.txt",
  chunkIndex: 0, content: "Annual leave is 18 days.", similarity: 0.8,
}]);

test("no context returns the validated fallback without calling a provider", async () => {
  const result = await generateRagAnswer("How much leave?", buildDocumentContext([]), async () => {
    assert.fail("Provider must not be called without context");
  });
  assert.equal(result.status, "insufficient_information");
  assert.deepEqual(result.citations, []);
  assert.deepEqual(result.sources, []);
});

test("sends prepared evidence to the adapter and resolves validated citations", async () => {
  let calls = 0;
  const result = await generateRagAnswer("How much leave?", context(), async messages => {
    calls++;
    assert.deepEqual(messages.map(message => message.role), ["system", "user"]);
    const input = JSON.parse(messages[1].content);
    assert.equal(input.question, "How much leave?");
    assert.equal(input.evidence[0].sourceId, "S1");
    return JSON.stringify({ status: "answered", answer: "Annual leave is 18 days. [S1]", citations: ["S1"] });
  });
  assert.equal(calls, 1);
  assert.equal(result.sources[0].chunkId, "chunk-1");
});

test("rejects malformed and invented-citation provider responses", async () => {
  for (const [output, code] of [
    ["not JSON", "INVALID_JSON"],
    [JSON.stringify({status: "answered", answer: "Text [S99]", citations: ["S99"]}), "UNKNOWN_CITATION"],
  ]) {
    await assert.rejects(generateRagAnswer("Question?", context(), async () => output), error => error.code === code);
  }
});

test("provider failure remains a failure rather than becoming a no-information answer", async () => {
  const failure = new Error("Simulated provider failure");
  await assert.rejects(generateRagAnswer("Question?", context(), async () => { throw failure; }), error => error === failure);
});

test("invalid questions are rejected before calling the provider", async () => {
  await assert.rejects(generateRagAnswer(" ", context(), async () => {
    assert.fail("Provider must not be called with an invalid question");
  }), /Question/);
});
