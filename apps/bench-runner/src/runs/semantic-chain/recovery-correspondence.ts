import { join, resolve } from "node:path";
import { AlayaError, SourceSemanticReasoningResultSchema, canonicalJson } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset,
  semanticProposalWorksetContract } from "../semantic-proposal/workset.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainArtifact, writeChainJson } from "./contract.js";
import { admitInitialQualified } from "./recovery-publication.js";
import { admitFinalRecoveryQualified } from "./recovery-final-publication.js";
import { admitRecoveryQueryReview } from "./recovery-query-review.js";
import { reserveRecoveryRead, reserveRecoveryHostEffect } from "./recovery-allowance.js";
import { prepareRetainedSemanticProposalRevision } from "../semantic-proposal/fill.js";
import { readSemanticChainProposalResults } from "./inputs.js";
import { admitRecoveryNomination } from "./recovery-reason.js";

/** One Q and the physically published H descriptors own the current C inputs. */
export function buildRecoveryCorrespondenceWorkset(query: Readonly<{
  original_query: string; query_semantics: import("@do-soul/alaya-protocol").SourceSemanticQuery
}>, descriptors: readonly Readonly<{ descriptor: { source_interpretation_id: string; interpretation: unknown } }>[],
generation: Readonly<{ model: string; request_profile: string; provider_url: string }>) {
  return descriptors.length === 0 ? null : parseSemanticProposalWorkset({
    contract: semanticProposalWorksetContract(generation.request_profile), kind: "semantic_correspondence",
    model: generation.model, request_profile: generation.request_profile, provider_url: generation.provider_url,
    items: descriptors.map(row => ({ original_query: query.original_query,
      admitted_query_semantics: query.query_semantics,
      source_interpretation_descriptors: [row.descriptor] }))
  });
}

/** Reuse current C when its request key is unchanged; revise the nominated parent only on its retained attention. */
export function applyAffectedRecoveryCorrespondencePolicy(input: Readonly<{
  selected: readonly Readonly<{ source_id: string; source_version: string; record_id: string;
    descriptor: { source_interpretation_id: string } }>[];
  baseWorkset: ReturnType<typeof buildRecoveryCorrespondenceWorkset>;
  initialWorkset: ReturnType<typeof buildRecoveryCorrespondenceWorkset>;
  initialCacheRoot: string; maxOutputTokens: number; queryChanged: boolean;
  nomination: Readonly<{ source_id: string; source_version: string; record_id: string }> | null;
  reasonResults: readonly Readonly<{ source_interpretation_id?: string; response?: { result?: unknown } }>[];
}>) {
  const initialLines = input.initialWorkset === null ? []
    : materializeSemanticProposalLines(input.initialWorkset, input.maxOutputTokens);
  const initialKeys = new Set(initialLines.map(line => line.key));
  let workset = input.baseWorkset;
  if (!input.queryChanged && workset !== null && input.initialWorkset !== null && input.nomination !== null) {
    const baseLines = materializeSemanticProposalLines(workset, input.maxOutputTokens);
    const selectedIndex = input.selected.findIndex(row => row.source_id === input.nomination!.source_id &&
      row.source_version === input.nomination!.source_version && row.record_id === input.nomination!.record_id);
    const current = input.selected[selectedIndex];
    const parentIndex = initialLines.findIndex(line => line.key === baseLines[selectedIndex]?.key);
    if (current !== undefined && parentIndex >= 0) {
      const reasoning = input.reasonResults.find(row => row.source_interpretation_id ===
        current.descriptor.source_interpretation_id)?.response?.result;
      const result = reasoning === undefined ? undefined : SourceSemanticReasoningResultSchema.parse(reasoning);
      const attention = result?.attention;
      const comments = attention?.source_interpretation_id !== current.descriptor.source_interpretation_id ? []
        : attention.kind === "preparation" && attention.missing === "semantic_correspondence"
          ? [JSON.stringify({ state: "semantic_correspondence_missing", observation: attention.observation })]
          : attention.kind === "computed" && !attention.truncated && attention.entries.length <= 32 &&
              attention.entries.some(entry => entry.state === "correspondence_missing") &&
              attention.semantic_correspondence_id === result?.semantic_correspondence_id
            ? attention.entries.map(entry => JSON.stringify(entry)) : [];
      if (comments.length > 0 && comments.every(comment => comment.length <= 2048)) {
        const parentRows = readSemanticChainProposalResults(input.initialWorkset,
          input.initialCacheRoot, input.maxOutputTokens);
        if (parentRows[parentIndex]?.shard !== undefined &&
            !["pending", "unknown", "unattempted", "cache_invalid", "unavailable"].includes(parentRows[parentIndex]!.status)) {
          const revision = prepareRetainedSemanticProposalRevision({ workset: input.initialWorkset,
            parentCacheRoot: input.initialCacheRoot, maxOutputTokens: input.maxOutputTokens,
            itemIndex: parentIndex, reviewComments: comments });
          workset = parseSemanticProposalWorkset({ ...workset,
            revision_parent_cache_root: input.initialCacheRoot,
            items: workset.items.map((item, index) => index === selectedIndex ? { ...(item as object), revision } : item) });
        }
      }
    }
  }
  return { workset, initialKeys };
}

function initialCorrespondenceInputs(root: string, readAllowanceRoot: string) {
  const { window, settled } = admitInitialQualified(root, readAllowanceRoot);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  const query = plan.queries[0];
  if (query?.status !== "ready" || plan.queries.length !== 1 || query.query_key !== window.query_key) {
    throw new AlayaError("CONFLICT", "initial C requires the frozen admitted original query");
  }
  const generation = plan.config.correspondence_generation;
  if (generation === undefined) throw new AlayaError("VALIDATION", "recovery requires an explicit C producer setting");
  const selected = settled.descriptor_export.slice(0, plan.config.correspondence_pair_cap);
  const workset = buildRecoveryCorrespondenceWorkset(query, selected, generation);
  return { settled, query, selected, workset };
}

/** Materialize only the frozen Q and physically published H descriptors for separately funded C. */
export function prepareInitialRecoveryCorrespondence(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "prepare initial C inputs");
  const { settled, query, selected, workset } = initialCorrespondenceInputs(root, root);
  const path = join(root, "initial-correspondence-workset.json");
  reserveRecoveryHostEffect(root, "initial-C-workset", chainIdentity({ workset, qualified: settled.publication_identity }),
    readChainArtifact(join(root, "initial-correspondence-binding.json")) !== undefined);
  if (workset !== null) writeChainJson(path, workset);
  writeChainArtifact(join(root, "initial-correspondence-binding.json"), {
    workset_identity: workset === null ? null : chainIdentity(workset), query_key: query.query_key,
    qualified_snapshot_identity: settled.publication_identity,
    source_interpretation_ids: selected.map(row => row.descriptor.source_interpretation_id)
  });
  return { workset_path: workset === null ? null : path,
    workset_identity: workset === null ? null : chainIdentity(workset), selected_source_count: selected.length,
    qualified_snapshot_identity: settled.publication_identity };
}

/** Re-admit the original C owner while charging a comparison arm for its own reads. */
export function admitInitialRecoveryCorrespondence(rootInput: string, readAllowanceRootInput: string) {
  const root = resolve(rootInput), readAllowanceRoot = resolve(readAllowanceRootInput);
  reserveRecoveryRead(readAllowanceRoot, "admit original initial C inputs");
  const { settled, query, selected, workset } = initialCorrespondenceInputs(root, readAllowanceRoot);
  const path = join(root, "initial-correspondence-workset.json");
  const identity = workset === null ? null : chainIdentity(workset);
  const binding = readChainArtifact(join(root, "initial-correspondence-binding.json")) as {
    workset_identity?: string | null; query_key?: string; qualified_snapshot_identity?: string;
    source_interpretation_ids?: string[] } | undefined;
  if (binding?.workset_identity !== identity || binding.query_key !== query.query_key ||
      binding.qualified_snapshot_identity !== settled.publication_identity ||
      canonicalJson(binding.source_interpretation_ids) !==
        canonicalJson(selected.map(row => row.descriptor.source_interpretation_id)) ||
      (workset !== null && chainIdentity(parseSemanticProposalWorkset(JSON.parse(
        readBoundedCanonicalUtf8Artifact({ path, maxBytes: 32 * 1024 * 1024,
          label: "original initial C workset" })))) !== identity)) {
    throw new AlayaError("CONFLICT", "original initial C workset changed after settlement");
  }
  return { workset_path: workset === null ? null : path, workset_identity: identity,
    selected_source_count: selected.length, qualified_snapshot_identity: settled.publication_identity };
}

/** Rebuild exact current C inputs from the final native H export and the admitted Q review. */
export function prepareFinalRecoveryCorrespondence(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "prepare final C inputs");
  const { window, final } = admitFinalRecoveryQualified(root);
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  const query = plan.queries[0];
  const review = admitRecoveryQueryReview(root).result;
  if (query?.status !== "ready" || plan.queries.length !== 1 || query.query_key !== window.query_key ||
      review.active_query === undefined) {
    throw new AlayaError("CONFLICT", "final C requires settled original-only Q review");
  }
  const generation = plan.config.correspondence_generation;
  if (generation === undefined) throw new AlayaError("VALIDATION", "recovery requires an explicit C producer setting");
  const selected = final.descriptor_export.slice(0, plan.config.correspondence_pair_cap);
  const baseWorkset = buildRecoveryCorrespondenceWorkset({ original_query: query.original_query,
    query_semantics: review.active_query }, selected, generation);
  const cap = generation.max_output_tokens;
  const initial = prepareInitialRecoveryCorrespondence(root);
  const initialWorkset = initial.workset_path === null ? null : parseSemanticProposalWorkset(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path: initial.workset_path,
      maxBytes: 32 * 1024 * 1024, label: "initial C workset" })));
  let nomination: ReturnType<typeof admitRecoveryNomination> | null = null;
  let reasonResults: { source_interpretation_id?: string; response?: { result?: unknown } }[] = [];
  if (!review.changed && baseWorkset !== null && initialWorkset !== null) {
    nomination = admitRecoveryNomination(root);
    const reason = readChainArtifact(join(root, "initial-reason.json")) as { identity?: string;
      results?: { source_interpretation_id?: string; response?: { result?: unknown } }[] } | undefined;
    if (reason?.identity !== nomination.reason_identity || !Array.isArray(reason?.results)) {
      throw new AlayaError("CONFLICT", "C revision lacks its admitted initial reason");
    }
    reasonResults = reason!.results!;
  }
  const { workset, initialKeys } = applyAffectedRecoveryCorrespondencePolicy({
    selected, baseWorkset, initialWorkset, initialCacheRoot: plan.config.correspondence_cache_root,
    maxOutputTokens: cap, queryChanged: review.changed, nomination, reasonResults });
  const path = join(root, "final-correspondence-workset.json");
  reserveRecoveryHostEffect(root, "final-C-workset", chainIdentity({ workset, final: final.publication_identity,
    review: chainIdentity(review) }), readChainArtifact(join(root, "final-correspondence-binding.json")) !== undefined);
  if (workset !== null) writeChainJson(path, workset);
  const lines = workset === null ? [] : materializeSemanticProposalLines(workset, cap);
  const newItems = workset?.items.filter((_, index) => !initialKeys.has(lines[index]!.key)) ?? [];
  const newWorkset = workset === null || newItems.length === 0 ? null : { ...workset, items: newItems };
  const newPath = join(root, "final-correspondence-new-workset.json");
  if (newWorkset !== null) writeChainJson(newPath, newWorkset);
  const newCacheRoot = join(root, "final-correspondence-cache");
  const cacheOwners = lines.map(line => ({ key: line.key,
    cache_root: initialKeys.has(line.key) ? plan.config.correspondence_cache_root : newCacheRoot }));
  const binding = { workset_identity: workset === null ? null : chainIdentity(workset),
    query_review_identity: chainIdentity(review), final_publication_identity: final.publication_identity,
    query_key: query.query_key, source_interpretation_ids: selected.map(row => row.descriptor.source_interpretation_id),
    new_workset_identity: newWorkset === null ? null : chainIdentity(newWorkset), cache_owners: cacheOwners };
  writeChainArtifact(join(root, "final-correspondence-binding.json"), binding);
  return { workset_path: workset === null ? null : path, new_workset_path: newWorkset === null ? null : newPath,
    new_cache_root: newCacheRoot, ...binding, selected_source_count: selected.length };
}
