import type { SoulInterpretationResponse } from "@do-soul/alaya-protocol";
import type { admitOrdinaryRecallObservation } from "./ordinary-recall.js";

type OrdinaryEvidence = ReturnType<typeof admitOrdinaryRecallObservation>["evidence"];
type LibraryDelivery = Extract<SoulInterpretationResponse, { operation: "recall" }>;
type Slot = { owner: Record<string, unknown>; key: string; path: string };

/** Paths are out-of-band; source-provided values never become reference instructions. */
export function exactOrdinaryMetadataReferenceView(evidence: OrdinaryEvidence) {
  const observation = structuredClone(evidence), slots: Slot[] = [];
  for (const [ordinal, call] of observation.calls.entries()) {
    const path = `/calls/${ordinal}`;
    collect(slots, call.request, "query", `${path}/request/query`);
    collect(slots, call.request, "continuation", `${path}/request/continuation`);
    if (call.response_state !== "success") continue;
    const output = (call.envelope?.structuredContent as {
      output?: { index?: unknown; results?: unknown[] };
    } | undefined)?.output;
    const outputPath = `${path}/envelope/structuredContent/output`;
    collect(slots, output?.index, "continuation", `${outputPath}/index/continuation`);
    collect(slots, output?.index, "completeness", `${outputPath}/index/completeness`);
    for (const [index, result] of (output?.results ?? []).entries()) {
      collect(slots, result, "source_disclosure", `${outputPath}/results/${index}/source_disclosure`);
    }
  }
  return { contract: "ordinary-recall-exact-reference-view-v1" as const, observation,
    metadata: deduplicateExactValues(slots) };
}

/** Equal complete forests keep all distinct occurrences; overlapping forests are not merged. */
export function exactLibraryProofReferenceView(evidence: LibraryDelivery) {
  const observation = structuredClone(evidence), slots: Slot[] = [];
  collect(slots, observation.index, "explanations", "/index/explanations");
  for (const [index, proof] of (observation.proofs ?? []).entries()) {
    collect(slots, proof, "derivations", `/proofs/${index}/derivations`);
  }
  return { contract: "semantic-library-exact-reference-view-v1" as const, observation,
    metadata: deduplicateExactValues(slots) };
}

function collect(slots: Slot[], owner: unknown, key: string, path: string): void {
  if (owner === null || typeof owner !== "object" || Array.isArray(owner)) return;
  slots.push({ owner: owner as Record<string, unknown>, key, path });
}

/** Share only identical JSON values whose side-table entry costs less than the inline occurrences. */
function deduplicateExactValues(slots: readonly Slot[]) {
  const groups = new Map<string, { value: unknown; slots: Slot[] }>();
  for (const slot of slots) {
    const value = slot.owner[slot.key], encoded = JSON.stringify(value);
    if (encoded === undefined) continue;
    const group = groups.get(encoded) ?? { value, slots: [] };
    group.slots.push(slot); groups.set(encoded, group);
  }
  const metadata: { paths: string[]; value: unknown }[] = [];
  for (const [encoded, group] of groups) {
    if (group.slots.length < 2) continue;
    const entry = { paths: group.slots.map(slot => slot.path), value: group.value };
    if (Buffer.byteLength(JSON.stringify(entry)) + 1 >= Buffer.byteLength(encoded) * group.slots.length) continue;
    metadata.push(entry);
    for (const slot of group.slots) delete slot.owner[slot.key];
  }
  return metadata;
}
