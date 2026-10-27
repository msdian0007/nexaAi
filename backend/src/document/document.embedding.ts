import { env, pipeline, FeatureExtractionPipeline } from "@huggingface/transformers";
import path from "node:path";
import { EMBEDDING_PROFILE } from "./document.embedding.profile";

let extractor: FeatureExtractionPipeline | null = null;

// Keep downloaded models outside node_modules so a clean npm install does not
// delete them. Containers override this with their shared writable model volume.
env.cacheDir = process.env.TRANSFORMERS_CACHE?.trim() ||
  path.resolve(process.cwd(), ".cache", "transformers");

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
