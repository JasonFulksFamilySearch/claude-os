import { describe, it, expect } from "vitest";
import { serializeVector, EMBEDDING_DIM, MODEL_ID, EMBEDDING_DTYPE } from "../src/embedder.js";

describe("constants", () => {
  it("EMBEDDING_DIM matches nomic-embed-text output size", () => {
    expect(EMBEDDING_DIM).toBe(768);
  });

  it("MODEL_ID references nomic-embed-text-v1.5", () => {
    expect(MODEL_ID).toContain("nomic-embed-text");
  });

  it("EMBEDDING_DTYPE is q8 (int8 quantized weights — the RAM-saving choice)", () => {
    // Pins the chosen precision; catches an accidental revert to fp32.
    expect(EMBEDDING_DTYPE).toBe("q8");
  });
});

describe("serializeVector", () => {
  it("produces a buffer of the correct byte length (float32 = 4 bytes each)", () => {
    const v = new Float32Array(EMBEDDING_DIM).fill(0.5);
    const buf = serializeVector(v);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.byteLength).toBe(EMBEDDING_DIM * 4);
  });

  it("round-trips float values through Buffer", () => {
    const v = new Float32Array([1.0, 2.0, 3.0]);
    const buf = serializeVector(v);
    const back = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    expect(Array.from(back)).toEqual([1.0, 2.0, 3.0]);
  });

  it("handles empty vector", () => {
    const v = new Float32Array(0);
    const buf = serializeVector(v);
    expect(buf.byteLength).toBe(0);
  });
});
