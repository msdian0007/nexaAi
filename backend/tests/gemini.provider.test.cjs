const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createGeminiGenerator } = require("../dist/src/rag/gemini.provider");
const { generateRagAnswer } = require("../dist/src/rag/rag.generation");
const { buildDocumentContext } = require("../dist/src/document/document.context");

const messages = [{ role: "system", content: "Application rules" }, { role: "user", content: "Evidence" }];
const answer = JSON.stringify({ status: "answered", answer: "18 days. [S1]", citations: ["S1"] });
const envelope = (overrides = {}) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: answer }] }, ...overrides }] });
const make = fetchImpl => createGeminiGenerator({ apiKey: "test-key", model: "gemini-3.8-flash", fetchImpl });
const returns = body => make(async () => Response.json(body));

test("sends Gemini instructions and evidence separately with a JSON schema and header authentication", async () => {
  let calls = 0;
  const generate = make(async (url, init) => {
    calls++;
    assert.equal(url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent");
    assert.equal(init.headers["x-goog-api-key"], "test-key");
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const body = JSON.parse(init.body);
    assert.equal(body.systemInstruction.parts[0].text, "Application rules");
    assert.equal(body.contents[0].parts[0].text, "Evidence");
    assert.equal(body.generationConfig.responseFormat.text.mimeType, "APPLICATION_JSON");
    assert.deepEqual(body.generationConfig.responseFormat.text.schema.required, ["status", "answer", "citations"]);
    assert.equal(body.generationConfig.maxOutputTokens, 4096);
    return Response.json(envelope());
  });
  assert.equal(await generate(messages), answer);
  assert.equal(calls, 1);
});

test("maps HTTP failures without leaking error bodies or retrying", async () => {
  for (const [status, code] of [[400, "REQUEST_REJECTED"], [401, "AUTHENTICATION"], [403, "AUTHENTICATION"], [404, "MODEL_UNAVAILABLE"], [429, "QUOTA"], [503, "UNAVAILABLE"]]) {
    let calls = 0;
    const generate = make(async () => { calls++; return new Response("private content test-key", { status }); });
    await assert.rejects(generate(messages), error => error.code === code && !error.message.includes("test-key") && !error.message.includes("private"));
    assert.equal(calls, 1);
  }
});

test("rejects blocked, truncated, and malformed responses", async () => {
  for (const [body, code] of [
    [{ promptFeedback: { blockReason: "SAFETY" } }, "BLOCKED"],
    [envelope({ finishReason: "SAFETY" }), "BLOCKED"],
    [envelope({ finishReason: "MAX_TOKENS" }), "INCOMPLETE_RESPONSE"],
    [envelope({ finishReason: undefined }), "INCOMPLETE_RESPONSE"],
    [{}, "INVALID_RESPONSE"], [null, "INVALID_RESPONSE"],
    [envelope({ content: { parts: [] } }), "INVALID_RESPONSE"],
  ]) await assert.rejects(returns(body)(messages), error => error.code === code);
  await assert.rejects(make(async () => new Response("not JSON"))(messages), error => error.code === "INVALID_RESPONSE");
});

test("ignores thought text and joins final answer parts", async () => {
  const generate = returns(envelope({ content: { parts: [{ thought: true, text: "Internal thought" }, { text: answer.slice(0, 10) }, { text: answer.slice(10) }] } }));
  assert.equal(await generate(messages), answer);
});

test("times out both connection and response body reads", async () => {
  for (const bodyOnly of [false, true]) {
    const generate = createGeminiGenerator({ apiKey: "test-key", timeoutMs: 10, fetchImpl: async (_url, init) => {
      const waitForAbort = () => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      if (bodyOnly) return { ok: true, json: waitForAbort };
      return waitForAbort();
    } });
    await assert.rejects(generate(messages), error => error.code === "TIMEOUT");
  }
});

test("sanitizes network errors and rejects invalid configuration before sending", async () => {
  await assert.rejects(make(async () => { throw new Error("private test-key"); })(messages), error => error.code === "NETWORK" && !error.message.includes("test-key"));
  for (const config of [{ apiKey: "" }, { apiKey: "test-key", model: "../other" }, { apiKey: "test-key", timeoutMs: 0 }]) {
    const generate = createGeminiGenerator({ ...config, fetchImpl: async () => assert.fail("No request expected") });
    await assert.rejects(generate(messages), error => error.code === "CONFIGURATION");
  }
});

test("generation wrapper validates Gemini output and skips Gemini for empty evidence", async () => {
  const context = buildDocumentContext([{ chunkId: "c", documentId: "d", documentName: "demo.txt", chunkIndex: 0, content: "18 days leave", similarity: 0.8 }]);
  const result = await generateRagAnswer("How much leave?", context, returns(envelope()));
  assert.equal(result.sources[0].chunkId, "c");
  const invalid = envelope({ content: { parts: [{ text: JSON.stringify({status: "answered", answer: "18 days [S99]", citations: ["S99"]}) }] } });
  await assert.rejects(generateRagAnswer("How much leave?", context, returns(invalid)), error => error.code === "UNKNOWN_CITATION");
  const fallback = await generateRagAnswer("Question?", buildDocumentContext([]), createGeminiGenerator({ apiKey: "", fetchImpl: async () => assert.fail("No request expected") }));
  assert.equal(fallback.status, "insufficient_information");
});
