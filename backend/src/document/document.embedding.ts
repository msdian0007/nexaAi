// import { openai } from "../config/openai";

// const EMBEDDING_MODEL = "text-embedding-3-small";

// export const generateEmbedding = async (
//   text: string
// ): Promise<number[]> => {
//   const response = await openai.embeddings.create({
//     model: EMBEDDING_MODEL,
//     input: text,
//   });

//   return response.data[0].embedding;
// };


import { pipeline, FeatureExtractionPipeline } from "@huggingface/transformers";
import prisma from "../config/database";

const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";

let extractor: FeatureExtractionPipeline | null = null;

const getExtractor = async () => {
  if (!extractor) {
    console.log("Loading local embedding model...");

    extractor = await pipeline("feature-extraction", EMBEDDING_MODEL);

    console.log("Local embedding model loaded.");
  }

  return extractor;
};

export const generateEmbedding = async (
  text: string
): Promise<number[]> => {
  const model = await getExtractor();

  const output = await model(text, {
    pooling: "mean",
    normalize: true,
  });

  return Array.from(output.data);
};