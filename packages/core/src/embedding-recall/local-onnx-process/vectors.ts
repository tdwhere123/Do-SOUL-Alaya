import {
  LOCAL_ONNX_EMBEDDING_DIMENSIONS
} from "./protocol.js";

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
  return Object.freeze(rows.map((row, index) => decodeLocalOnnxIpcRow(row, index)));
}

function decodeLocalOnnxIpcRow(row: unknown, index: number): Float32Array {
  if (!Array.isArray(row) || row.length === 0) {
    throw new Error(`Local ONNX embedding row ${index} was empty.`);
  }
  if (row.length !== LOCAL_ONNX_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Local ONNX embedding row ${index} had ${row.length} dimensions; ` +
        `expected ${LOCAL_ONNX_EMBEDDING_DIMENSIONS}.`
    );
  }
  const values = new Float32Array(row.length);
  for (let offset = 0; offset < row.length; offset += 1) {
    const value = row[offset];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Local ONNX embedding row ${index} contained a non-finite component.`);
    }
    values[offset] = value;
  }
  return values;
}

export function encodeLocalOnnxIpcVectors(
  vectors: readonly Float32Array[]
): readonly (readonly number[])[] {
  return vectors.map((vector) => Array.from(vector));
}
