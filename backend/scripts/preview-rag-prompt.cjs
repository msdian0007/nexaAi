// Illustrative preview only: no database, model, or external API calls.
const { buildDocumentContext } = require("../dist/src/document/document.context");
const { buildRagPrompt } = require("../dist/src/rag/rag.prompt");

const context = buildDocumentContext([{
  chunkId: "demo-chunk", documentId: "demo-document",
  documentName: "nexaai-employee-handbook.txt", chunkIndex: 0, similarity: 0.6,
  content: "Full-time employees receive 18 days of paid annual leave per calendar year.",
}]);
console.log(JSON.stringify(buildRagPrompt("How many vacation days do employees receive?", context), null, 2));
