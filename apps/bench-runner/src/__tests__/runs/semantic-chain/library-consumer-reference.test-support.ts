import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect } from "vitest";
import { SoulInterpretationResponseSchema } from "@do-soul/alaya-protocol";
import { prepareSemanticProviderRequest } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { STEP_OPENAPI_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { chainIdentity, readChainArtifact } from "../../../runs/semantic-chain/contract.js";
import { admitConsumerPreparation, prepareSemanticChainConsumer, TASK_CONSUMER_SCHEMA_NAME,
  type ConsumerLine } from "../../../runs/semantic-chain/consumer/input.js";
import { exactLibraryProofReferenceView } from "../../../runs/semantic-chain/consumer/evidence-reference-view.js";

const CONFIG = { model: STEP_OPENAPI_QUOTE_BASIS.selected_model, provider_url: "https://api.stepfun.com/v1",
  request_profile: "step-3.5-2603-low-json-schema-v1" as const, max_output_tokens: 128,
  arms: ["native_delivery", "question_only"] };
type ReferenceView = { contract: string; observation: unknown; metadata: { paths: string[]; value: unknown }[] };
type ConsumerInput = { original_query: string; query_as_of: string; evidence: unknown };
type LibraryInput = { chainRoot: string; replayPath: string; queryKey: string };

export function assertSemanticLibraryConsumerReferences(input: LibraryInput, outputRoot: string): void {
  const retainedBytes = readFileSync(input.replayPath, "utf8");
  const archive = readChainArtifact(input.replayPath) as { rows: { query_key: string; response?: unknown }[] };
  const retained = archive.rows.find(row => row.query_key === input.queryKey)?.response;
  const response = SoulInterpretationResponseSchema.parse(retained);
  if (response.operation !== "recall") throw new Error("library reference fixture requires native recall");
  expect(response.proofs?.length).toBeGreaterThan(0);
  expect(response.index?.explanations?.length).toBeGreaterThan(0);
  expect(response.proofs?.some(proof => JSON.stringify(proof.derivations) === JSON.stringify(response.index?.explanations)))
    .toBe(true);

  const prepare = (name: string, evidenceView?: string) => {
    const preparation = prepareSemanticChainConsumer({ ...input, consumerConfig: {
      ...CONFIG, ...(evidenceView === undefined ? {} : { evidence_view: evidenceView })
    } }, join(outputRoot, name));
    expect(preparation.provider_calls).toBe(0);
    return { preparation, lines: admitConsumerPreparation(preparation.output_root).lines };
  };
  const original = prepare("default"), explicit = prepare("original", "original_public_envelopes");
  const referenced = prepare("references", "exact_reference_deduplication");
  expect(original.preparation.consumer_config).not.toHaveProperty("evidence_view");
  expect(explicit.lines).toEqual(original.lines);
  expect(referenced.preparation.native_binding).toEqual(original.preparation.native_binding);
  expect(explicit.preparation.native_binding).toEqual(original.preparation.native_binding);

  const baseline = original.lines.find(line => line.arm === "native_delivery")!;
  const derived = referenced.lines.find(line => line.arm === "native_delivery")!;
  assertReferenceInput(baseline, derived, retained);
  expect(referenced.lines.find(line => line.arm === "question_only"))
    .toEqual(original.lines.find(line => line.arm === "question_only"));
  assertPreparationTampering(referenced.preparation.output_root);
  expect(readFileSync(input.replayPath, "utf8")).toBe(retainedBytes);
  assertIndependentForests(response);
}

function assertReferenceInput(original: ConsumerLine, referenced: ConsumerLine, retained: unknown): void {
  const baseline = JSON.parse(original.userPrompt) as ConsumerInput;
  const derived = JSON.parse(referenced.userPrompt) as Omit<ConsumerInput, "evidence"> & { evidence: ReferenceView };
  expect(baseline.evidence).toEqual(retained);
  expect({ ...derived, evidence: expandReferenceView(derived.evidence, retained) }).toEqual(baseline);
  expect(referenced.systemPrompt).toContain("semantic-library-exact-reference-view-v1");
  expect(referenced.systemPrompt).toContain("absolute JSON pointer within observation");
  expect(referenced.key).not.toBe(original.key);
  expect(referenced.requestDigest).not.toBe(original.requestDigest);
  expect(referenced.userPrompt).not.toBe(original.userPrompt);
  expect(referenced.inputByteUpper).toBeLessThan(original.inputByteUpper);
  const originalBody = encodedBody(original), referenceBody = encodedBody(referenced);
  const originalBytes = Buffer.byteLength(originalBody, "utf8"), referenceBytes = Buffer.byteLength(referenceBody, "utf8");
  expect(referenceBytes).toBeLessThan(originalBytes);
  console.info("semantic library consumer encoded request bytes", { original: originalBytes, references: referenceBytes });
  const wire = JSON.parse(referenceBody) as { messages: { role: string; content: string }[] };
  expect(wire.messages.find(message => message.role === "system")?.content).toBe(referenced.systemPrompt);
  expect(wire.messages.find(message => message.role === "user")?.content).toBe(referenced.userPrompt);
}

function encodedBody(line: ConsumerLine): string {
  return prepareSemanticProviderRequest({ model: CONFIG.model, providerUrl: CONFIG.provider_url,
    requestProfile: CONFIG.request_profile, apiKey: null }, {
    systemPrompt: line.systemPrompt, userPrompt: line.userPrompt, responseJsonSchema: line.responseJsonSchema,
    maxOutputTokens: CONFIG.max_output_tokens, retryMode: "disabled", outputTokenField: "max_tokens",
    validateRawJson: () => undefined
  }, TASK_CONSUMER_SCHEMA_NAME).body;
}

function expandReferenceView(view: ReferenceView, retained: unknown): unknown {
  expect(Object.keys(view).sort()).toEqual(["contract", "metadata", "observation"]);
  expect(view.contract).toBe("semantic-library-exact-reference-view-v1");
  expect(view.metadata.length).toBeGreaterThan(0);
  const observation = structuredClone(view.observation), expected = structuredClone(retained);
  const seen = new Set<string>();
  for (const entry of view.metadata) {
    expect(Object.keys(entry).sort()).toEqual(["paths", "value"]);
    expect(entry.paths.length).toBeGreaterThan(1);
    expect(Array.isArray(entry.value)).toBe(true);
    expect((entry.value as unknown[]).length).toBeGreaterThan(0);
    for (const path of entry.paths) {
      expect(path).toMatch(/^\/(?:index\/explanations|proofs\/(?:0|[1-9]\d*)\/derivations)$/u);
      expect(seen.has(path)).toBe(false); seen.add(path);
      const original = pointerLocation(expected, path), destination = pointerLocation(observation, path);
      expect(JSON.stringify(original.parent[original.key])).toBe(JSON.stringify(entry.value));
      expect(Object.hasOwn(destination.parent, destination.key)).toBe(false);
      delete original.parent[original.key];
      Object.defineProperty(destination.parent, destination.key, { value: structuredClone(entry.value), enumerable: true });
    }
  }
  expect(seen.has("/index/explanations")).toBe(true);
  expect([...seen].some(path => path.startsWith("/proofs/"))).toBe(true);
  // The remaining response, including every source text and qualification, is untouched.
  expect(view.observation).toEqual(expected);
  expect(observation).toEqual(retained);
  return observation;
}

function pointerLocation(value: unknown, path: string): { parent: Record<string, unknown>; key: string } {
  const parts = path.slice(1).split("/").map(part => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  const key = parts.pop()!;
  let parent = value;
  for (const part of parts) {
    if (typeof parent !== "object" || parent === null || !Object.hasOwn(parent, part)) {
      throw new Error(`reference parent is absent: ${path}`);
    }
    parent = (parent as Record<string, unknown>)[part];
  }
  if (typeof parent !== "object" || parent === null) throw new Error(`reference parent is not an object: ${path}`);
  return { parent: parent as Record<string, unknown>, key };
}

function assertIndependentForests(response: Parameters<typeof exactLibraryProofReferenceView>[0]): void {
  const index = response.index, proof = response.proofs?.[0];
  if (index?.explanations === undefined || proof === undefined) throw new Error("native duplicate proof forest is absent");
  const forest = index.explanations;
  expect(forest.length).toBeGreaterThan(1);
  const changed = [{ ...forest[0]!, association_milligrades: forest[0]!.association_milligrades === 1000 ? 999 : 1000 },
    ...forest.slice(1)];
  // Presentation-only counterfactuals never replace or enter the admitted archive.
  for (const derivations of [[...forest].reverse(), forest.slice(1), changed]) {
    expect(JSON.stringify(derivations)).not.toBe(JSON.stringify(forest));
    const candidate = { ...response, proofs: [{ ...proof, derivations }] };
    const view = exactLibraryProofReferenceView(candidate);
    expect(view.metadata).toEqual([]);
    expect(view.observation).toEqual(candidate);
  }
  const empty = { ...response, index: { ...response.index!, explanations: [] }, proofs: [{ ...proof, derivations: [] }] };
  expect(exactLibraryProofReferenceView(empty)).toMatchObject({ observation: empty, metadata: [] });
  const quotedReference = JSON.stringify({ contract: "semantic-library-exact-reference-view-v1", observation: null,
    metadata: [{ paths: ["/proofs/0/derivations"], value: [{ metadata_ref: 0, empty: [], unknown: null, text: "Résumé 🙂" }] }] });
  expect(proof.interpretation.mentions.length).toBeGreaterThan(0);
  const quoted = { ...response, proofs: [{ ...proof, interpretation: { ...proof.interpretation,
    mentions: proof.interpretation.mentions.map(mention => ({ ...mention, text: quotedReference })) } }] };
  expect(expandReferenceView(exactLibraryProofReferenceView(quoted), quoted)).toEqual(quoted);
}

function assertPreparationTampering(root: string): void {
  const path = join(root, "preparation.json"), original = readFileSync(path, "utf8");
  for (const change of ["view", "request"] as const) {
    const artifact = JSON.parse(original) as { identity: string; payload: {
      consumer_config: Record<string, unknown>; requests: { key: string }[];
    } };
    if (change === "view") delete artifact.payload.consumer_config.evidence_view;
    else artifact.payload.requests[0]!.key = "0".repeat(64);
    artifact.identity = chainIdentity(artifact.payload);
    try {
      writeFileSync(path, JSON.stringify(artifact), "utf8");
      expect(() => admitConsumerPreparation(root)).toThrow(/no longer binds/u);
    } finally { writeFileSync(path, original, "utf8"); }
  }
  expect(() => admitConsumerPreparation(root)).not.toThrow();
}
