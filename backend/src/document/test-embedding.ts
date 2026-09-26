// import { generateEmbedding } from "./document.embedding";

// const run = async () => {
//   const embedding = await generateEmbedding(
//     "NexaAI is an AI powered document intelligence platform."
//   );

//   console.log("Embedding length:", embedding.length);
//   console.log("First values:", embedding.slice(0, 5));
// };

// run().catch(console.error);



import { generateEmbedding } from "./document.embedding";

const run = async () => {
  const embedding = await generateEmbedding(
    "NexaAI is an AI powered document intelligence platform."
  );

  console.log("Embedding length:", embedding.length);

  console.log(
    "First values:",
    embedding.slice(0, 5)
  );
};

run().catch(console.error);