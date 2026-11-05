import { expect, it } from "vitest";
import { cosineSimilarity, createCosineBatchScorer, createValidatedCosineBatchScorer } from "../../embedding-recall/helpers.js";

it("reads each candidate dimension once while matching independent exact cosine", () => {
  const query = new Float32Array(384);
  for (let i = 0; i < query.length; i++) query[i] = (i % 19 - 9) / 13;
  const score = createValidatedCosineBatchScorer(query);
  for (let row = 0; row < 512; row++) {
    const candidate = new Float32Array(384);
    for (let i = 0; i < candidate.length; i++) candidate[i] = ((i * 7 + row * 11) % 37 - 18) / 17;
    let dot = 0, querySquared = 0, candidateSquared = 0;
    for (let i = 0; i < candidate.length; i++) dot += query[i]! * candidate[i]!;
    for (const value of query) querySquared += value * value;
    for (const value of candidate) candidateSquared += value * value;
    let reads = 0;
    const observed = new Proxy(candidate, { get(target, property) {
      if (typeof property === "string" && /^\d+$/.test(property)) reads++;
      return Reflect.get(target, property, target);
    } });
    expect(score(observed)).toBe(dot / (Math.sqrt(querySquared) * Math.sqrt(candidateSquared)));
    expect(reads).toBe(384);
  }
});

it("rejects invalid, zero and mismatched candidates without treating them as zero similarity", () => {
  const score = createValidatedCosineBatchScorer(new Float32Array([1, 0, 0]));
  expect(score(new Float32Array([0, 1, 0]))).toBe(0);
  for (const candidate of [new Float32Array(3), new Float32Array([NaN, 1, 0]),
    new Float32Array([Infinity, 1, 0]), new Float32Array([1, 0])]) expect(score(candidate)).toBeNull();
  const left = new Float32Array([1, 0, 0]);
  const legacy = createCosineBatchScorer(left);
  expect(cosineSimilarity(left, new Float32Array(3))).toBe(0);
  expect(legacy(new Float32Array(3))).toBe(0);
  expect(cosineSimilarity(left, new Float32Array([NaN, 1, 0]))).toBeNaN();
  expect(legacy(new Float32Array([NaN, 1, 0]))).toBeNaN();
});
