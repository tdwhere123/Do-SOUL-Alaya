import { LOCAL_ONNX_EMBEDDING_DIMENSIONS, type LocalOnnxSourceResult } from "./protocol.js";
import { CoreError } from "../../shared/errors.js";
import {
  SOURCE_EMBEDDING_MAX_BATCH_INPUTS,
  validateSourceEmbeddingResults,
  type SourceEmbeddingInput,
  type SourceEmbeddingResult
} from "../source-embedding-runtime.js";
import type { SourceIndexProfile } from "@do-soul/alaya-protocol";

export function decodeLocalOnnxIpcVectors(
  rows: unknown,
  expectedCount: number
): readonly Float32Array[] {
  if (!Array.isArray(rows)) {
    throw new Error("Local ONNX embedding child returned no vector payload.");
  }
  if (rows.length !== expectedCount) {
    throw new Error(
      `Local ONNX embedding returned ${rows.length} vectors for ${expectedCount} inputs.`
    );
  }
  return Object.freeze(Array.from(rows, (row, index) => decodeLocalOnnxIpcRow(row, index)));
}

function decodeLocalOnnxIpcRow(row: unknown, index: number, dimensions = LOCAL_ONNX_EMBEDDING_DIMENSIONS): Float32Array {
  if (!Array.isArray(row) || row.length === 0) {
    throw new Error(`Local ONNX embedding row ${index} was empty.`);
  }
  if (row.length !== dimensions) {
    throw new Error(
      `Local ONNX embedding row ${index} had ${row.length} dimensions; ` +
        `expected ${dimensions}.`
    );
  }
  const values = new Float32Array(row.length);
  for (let offset = 0; offset < row.length; offset += 1) {
    const value = row[offset];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Local ONNX embedding row ${index} contained a non-finite component.`);
    }
    values[offset] = value;
    if (!Number.isFinite(values[offset])) throw new CoreError("OBLIGATION_VIOLATION", "Local ONNX embedding component overflows float32.");
  }
  return values;
}

export function decodeLocalOnnxSourceResults(rows: readonly LocalOnnxSourceResult[] | undefined,
  inputs: readonly SourceEmbeddingInput[], profile: SourceIndexProfile): readonly SourceEmbeddingResult[] {
  if (!Array.isArray(rows)) throw new CoreError("OBLIGATION_VIOLATION", "Missing Source embedding evidence");
  if (inputs.length > SOURCE_EMBEDDING_MAX_BATCH_INPUTS || rows.length > SOURCE_EMBEDDING_MAX_BATCH_INPUTS) {
    throw new CoreError("VALIDATION", `Source embedding batch exceeds ${SOURCE_EMBEDDING_MAX_BATCH_INPUTS} inputs`);
  }
  if (rows.length !== inputs.length) {
    throw new CoreError("OBLIGATION_VIOLATION", "Source embedding result count mismatch");
  }
  const results = Array.from(rows, row => row.status === "embedded" ? { ...row, vector: decodeLocalOnnxIpcRow(row.vector, 0, profile.dimensions) } : row);
  return validateSourceEmbeddingResults(inputs, results, profile);
}

export function encodeLocalOnnxSourceResults(rows: readonly SourceEmbeddingResult[]): readonly LocalOnnxSourceResult[] {
  return rows.map(row => row.status === "embedded" ? { ...row, vector: Array.from(row.vector) } : { ...row });
}

export function encodeLocalOnnxIpcVectors(
  vectors: readonly Float32Array[]
): readonly (readonly number[])[] {
  return vectors.map((vector) => Array.from(vector));
}
