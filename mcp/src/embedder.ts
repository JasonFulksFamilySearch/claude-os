// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { pipeline, env } from "@huggingface/transformers";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { log } from "./logger.js";

export const MODEL_ID = "nomic-ai/nomic-embed-text-v1.5";
export const EMBEDDING_DIM = 768;
// int8-quantized weights load ~4x smaller in RAM (~1.5GB → ~400MB) than fp32.
// The model still outputs 768-dim float32, so stored vectors and search are unchanged.
export const EMBEDDING_DTYPE = "q8";

// Prefixes required by nomic-embed-text for quality results
const DOC_PREFIX = "search_document: ";
const QUERY_PREFIX = "search_query: ";

// Singleton pipeline — loaded once, reused for all subsequent calls
let _pipeline: FeatureExtractionPipeline | null = null;

async function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (_pipeline) return _pipeline;

  log("info", "Loading embedding model (first load — may download ~270 MB)", {
    model: MODEL_ID,
  });

  // Allow remote model download; cache goes to ~/.cache/huggingface by default
  env.allowLocalModels = true;
  env.allowRemoteModels = true;

  // Cast required: pipeline() overloads produce a union too wide for TS to narrow
  _pipeline = (await (pipeline as (task: string, model: string, opts: object) => Promise<unknown>)(
    "feature-extraction",
    MODEL_ID,
    { dtype: EMBEDDING_DTYPE },
  )) as FeatureExtractionPipeline;

  log("info", "Embedding model ready", { model: MODEL_ID });
  return _pipeline;
}

async function embed(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: "mean", normalize: true });
  // output.data is a Float32Array of shape [768] after mean pooling
  return output.data as Float32Array;
}

export async function embedDocument(text: string): Promise<Float32Array> {
  return embed(DOC_PREFIX + text);
}

export async function embedQuery(text: string): Promise<Float32Array> {
  return embed(QUERY_PREFIX + text);
}

// sqlite-vec expects the raw float32 bytes as a Buffer
export function serializeVector(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
