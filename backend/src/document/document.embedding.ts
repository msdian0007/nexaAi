import { pipeline, FeatureExtractionPipeline } from "@huggingface/transformers";
import { EMBEDDING_PROFILE } from "./document.embedding.profile";

let extractor: FeatureExtractionPipeline | null = null;

const getExtractor = async () => {
  if (!extractor) {
    console.log("Loading local embedding model...");

    extractor = await pipeline("feature-extraction", EMBEDDING_PROFILE.model);

    console.log("Local embedding model loaded.");
  }

  return extractor;
};

export const generateEmbedding = async (
  text: string
): Promise<number[]> => {
  const model = await getExtractor();

  const output = await model(text, {
    pooling: EMBEDDING_PROFILE.pooling,
    normalize: EMBEDDING_PROFILE.normalize,
  });

  return Array.from(output.data);
};
