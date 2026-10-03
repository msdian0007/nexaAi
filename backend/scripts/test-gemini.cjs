// One LIVE request using fictional evidence. Check the project's free tier first.
require("dotenv/config");
const { buildDocumentContext } = require("../dist/src/document/document.context");
const { generateRagAnswer } = require("../dist/src/rag/rag.generation");
const { generateGeminiText } = require("../dist/src/rag/gemini.provider");

const context = buildDocumentContext([{
  chunkId: "demo-chunk", documentId: "demo-document", documentName: "fictional-handbook.txt",
  chunkIndex: 0, similarity: 0.8,
  content: "Full-time employees receive 18 days of paid annual leave per calendar year.",
}]);
generateRagAnswer("How many days of paid annual leave do full-time employees receive?", context, generateGeminiText)
  .then(answer => console.log(JSON.stringify(answer, null, 2)))
  .catch(error => {
    console.error(`${error.code ?? "GENERATION_FAILED"}: ${error.message}`);
    process.exitCode = 1;
  });
