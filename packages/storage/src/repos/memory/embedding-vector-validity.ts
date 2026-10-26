const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function isFiniteNonzeroEmbedding(embedding: Float32Array): boolean {
  if (embedding.length <= 0) return false;
  let squaredMagnitude = 0;
  // Squares are non-negative, so one non-finite element keeps the sum non-finite.
  for (let index = 0; index < embedding.length; index += 1) {
    const value = embedding[index]!;
    squaredMagnitude += value * value;
  }
  return Number.isFinite(squaredMagnitude) && squaredMagnitude > 0;
}

export function decodeValidEmbeddingBlob(
  blob: Uint8Array,
  dimensions: number
): Float32Array | null {
  if (!hasExpectedEmbeddingByteLength(blob, dimensions)) return null;
  const embedding = new Float32Array(dimensions);
  if (!LITTLE_ENDIAN_HOST) return inspectEmbeddingBlob(blob, dimensions, embedding) ? embedding : null;
  // Stored floats are little-endian: a byte copy yields the same bit patterns as per-element reads.
  new Uint8Array(embedding.buffer).set(blob);
  return isFiniteNonzeroEmbedding(embedding) ? embedding : null;
}

export function isValidEmbeddingBlob(blob: Uint8Array, dimensions: number): boolean {
  return inspectEmbeddingBlob(blob, dimensions, null);
}

export function encodeEmbeddingBlob(embedding: Float32Array): Buffer {
  const blob = Buffer.alloc(embedding.length * Float32Array.BYTES_PER_ELEMENT);
  embedding.forEach((value, index) => {
    blob.writeFloatLE(value, index * Float32Array.BYTES_PER_ELEMENT);
  });
  return blob;
}

function hasFiniteNonzeroMagnitude(
  dimensions: number,
  readValue: (index: number) => number
): boolean {
  if (dimensions <= 0) return false;
  let squaredMagnitude = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = readValue(index);
    squaredMagnitude += value * value;
    if (!Number.isFinite(value) || !Number.isFinite(squaredMagnitude)) return false;
  }
  return squaredMagnitude > 0;
}

function inspectEmbeddingBlob(
  blob: Uint8Array,
  dimensions: number,
  output: Float32Array | null
): boolean {
  if (!hasExpectedEmbeddingByteLength(blob, dimensions)) return false;
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return hasFiniteNonzeroMagnitude(dimensions, (index) => {
    const value = view.getFloat32(index * Float32Array.BYTES_PER_ELEMENT, true);
    if (output !== null) output[index] = value;
    return value;
  });
}

function hasExpectedEmbeddingByteLength(blob: Uint8Array, dimensions: number): boolean {
  return Number.isInteger(dimensions) && dimensions > 0 &&
    blob.byteLength === dimensions * Float32Array.BYTES_PER_ELEMENT;
}
