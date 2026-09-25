import { join, resolve } from "node:path";
import { AlayaError, canonicalJson } from "@do-soul/alaya-protocol";
import { materializeSemanticProposalLines, parseSemanticProposalWorkset } from "../semantic-proposal/workset.js";
import { readBoundedCanonicalUtf8Artifact } from "../extraction/cache-audit/bounded-artifact-reader.js";
import { SemanticChainConfigSchema, SemanticChainPlanSchema, chainIdentity, readChainArtifact,
  withSemanticChainDaemon, writeChainArtifact } from "./contract.js";
import { readSemanticChainCorrespondenceOwners, readSemanticChainCorrespondences,
  semanticChainQueryCorrespondences } from "./inputs.js";
import { prepareSemanticChain } from "./prepare.js";
import { admitSemanticChainReplay, deliverPreparedSemanticChainQuery,
  inspectSemanticChainReplayTarget, closeSemanticChainReplayFromDurableRows } from "./replay.js";
import { admitFinalRecoveryQualified } from "./recovery-final-publication.js";
import { admitRecoveryQueryReview } from "./recovery-query-review.js";
import { prepareFinalRecoveryCorrespondence } from "./recovery-correspondence.js";
import { reserveRecoveryEffect } from "./recovery-window.js";
import { reserveRecoveryRead, reserveRecoveryAction, reserveRecoveryHostEffect,
  recordRecoveryNativeWork } from "./recovery-allowance.js";

function exactLines(workset: ReturnType<typeof parseSemanticProposalWorkset>, outputCap: number) {
  return materializeSemanticProposalLines(workset, outputCap).map(row => ({
    key: row.key, requestDigest: row.requestDigest, userPrompt: row.userPrompt,
    systemPrompt: row.systemPrompt, transport: row.transportProvenance
  })).sort((left, right) => left.key.localeCompare(right.key));
}

/** One final native pool observation and same-session recall, after Q/H/C are already settled. */
export async function deliverFinalRecoveryFirstExposure(rootInput: string) {
  const root = resolve(rootInput);
  reserveRecoveryRead(root, "final C/currentness and first exposure", [join(root, "final-qualified.sqlite")]);
  const { window, final } = admitFinalRecoveryQualified(root);
  const review = admitRecoveryQueryReview(root);
  const preparedC = prepareFinalRecoveryCorrespondence(root);
  const initialPlan = SemanticChainPlanSchema.parse(readChainArtifact(join(window.initial_chain_root, "prepare.json")));
  const outputCap = initialPlan.config.correspondence_generation?.max_output_tokens ?? initialPlan.config.max_output_tokens;
  const workset = preparedC.workset_path === null ? null : parseSemanticProposalWorkset(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path: preparedC.workset_path,
      maxBytes: 32 * 1024 * 1024, label: "settled final C workset" })));
  const cRows = workset === null ? [] : readSemanticChainCorrespondenceOwners(workset,
    initialPlan.config.correspondence_cache_root, outputCap, preparedC.cache_owners);
  if (cRows.some(row => row.shard === undefined || row.status === "unattempted" || row.status === "pending" ||
      row.status === "unknown" || row.status === "cache_invalid" || row.status === "unavailable")) {
    throw new AlayaError("CONFLICT", "final C has no terminal physical outcome for every exact current request");
  }
  const activeQChild = review.result.active_query_origin === "admitted_child";
  const { source_preview_extents: _initialPreviewExtents, ...baseConfig } = initialPlan.config;
  const config = SemanticChainConfigSchema.parse({ ...baseConfig,
    snapshot_path: final.snapshot_path, snapshot_sha256: final.snapshot_sha256,
    query_workset: activeQChild ? review.workset : initialPlan.config.query_workset,
    query_cache_root: activeQChild ? review.cacheRoot : initialPlan.config.query_cache_root,
    correspondence_cache_owners: preparedC.cache_owners,
    discovery_page_cap: 1 });
  const stageIdentity = chainIdentity({ final_publication: final.publication_identity,
    q_review: chainIdentity(review.result), c_binding: preparedC.workset_identity, config });
  const finalRoot = join(root, "final-chain"), exposurePath = join(root, "first-exposure.json");
  const retained = readChainArtifact(exposurePath) as { stage_identity?: string; replay_path?: string;
    replay_identity?: string } | undefined;
  if (retained !== undefined) {
    if (retained.stage_identity !== stageIdentity || retained.replay_path === undefined) {
      throw new AlayaError("CONFLICT", "final first exposure changed its frozen active inputs");
    }
    const admitted = admitSemanticChainReplay(finalRoot, retained.replay_path);
    if (admitted.replay.identity !== retained.replay_identity ||
        admitted.replay.rows[0]?.status !== "replayed") {
      throw new AlayaError("CONFLICT", "retained final exposure failed native archive admission");
    }
    return retained;
  }
  const preparedPlan = readChainArtifact(join(finalRoot, "prepare.json"));
  reserveRecoveryAction(root, "final-native-prepare", stageIdentity,
    config.budget.work_units, config.budget.memory_bytes, preparedPlan !== undefined);
  reserveRecoveryEffect(join(root, "final-prepare.reserved.json"), stageIdentity, preparedPlan !== undefined);
  if (preparedPlan === undefined) {
    reserveRecoveryHostEffect(root, "final-delivery-daemon", stageIdentity, false);
    reserveRecoveryAction(root, "final-native-recall", stageIdentity,
      config.budget.work_units, config.budget.memory_bytes, false);
  }
  if (preparedPlan === undefined) await withSemanticChainDaemon(config, finalRoot, async daemon => {
    let handle: string | undefined;
    const started = performance.now();
    const plan = await prepareSemanticChain(config, finalRoot, daemon, handles => {
      handle = handles.values().next().value;
    }, workset);
    const preparationElapsed = performance.now() - started;
    const query = plan.queries[0];
    if (plan.queries.length !== 1 || query?.status !== "ready" ||
        canonicalJson(query.query_semantics) !== canonicalJson(review.result.active_query) ||
        query.discovery_pages !== 1 || query.discovery_trace.length !== 1 ||
        query.discovery_trace[0]?.access.trace.kind !== "preparation_page") {
      throw new AlayaError("CONFLICT", "final native preparation changed active Q or its single pool observation");
    }
    if (handle === undefined || handle.length === 0) {
      throw new AlayaError("CONFLICT", "final native preparation did not retain a live same-pool query handle");
    }
    recordRecoveryNativeWork(root, "final-native-prepare", query.discovery_trace[0]!.work);
    for (const exported of final.descriptor_export) {
      const current = query.descriptors.find(row => row.interpretation_id === exported.descriptor.source_interpretation_id);
      if (current === undefined || canonicalJson(current.interpretation) !== canonicalJson(exported.descriptor.interpretation)) {
        throw new AlayaError("CONFLICT", "final native page did not read an exported current H descriptor");
      }
    }
    if (workset === null ? plan.correspondence_workset !== null : plan.correspondence_workset === null ||
        canonicalJson(exactLines(plan.correspondence_workset, outputCap)) !== canonicalJson(exactLines(workset, outputCap))) {
      throw new AlayaError("CONFLICT", "final native preparation rebuilt a different exact C request/key");
    }
    const target = inspectSemanticChainReplayTarget(finalRoot, "retained");
    const observed = readSemanticChainCorrespondences(plan, "retained");
    const { ready, outcomes } = semanticChainQueryCorrespondences(query, observed.semantic_correspondences);
    const rowPath = target.rowPaths.get(query.query_key)!;
    if (readChainArtifact(rowPath) !== undefined || readChainArtifact(`${rowPath}.reserved`) !== undefined) {
      throw new AlayaError("CONFLICT", "final native exposure already has a retained row or unresolved reservation");
    }
    writeChainArtifact(`${rowPath}.reserved`, { replay_identity: target.identity, query_key: query.query_key });
    const row = await deliverPreparedSemanticChainQuery({ daemon, config, query,
      prepared: { query_handle: handle, discovery: {
        descriptors: query.descriptors, discovery_trace: query.discovery_trace,
        discovery_pages: query.discovery_pages, discovery_open: query.discovery_open,
        discovery_truncated: query.discovery_truncated,
        unvisited_source_interpretation_count: query.unvisited_source_interpretation_count } },
      ready, outcomes, rowPath, replayIdentity: target.identity, preparationElapsed,
      preparationError: null, started });
    if ("response" in row && row.response?.operation === "recall") {
      recordRecoveryNativeWork(root, "final-native-recall", row.response.work);
    }
  });
  const closed = await closeSemanticChainReplayFromDurableRows(finalRoot);
  if (closed === null) {
    throw new AlayaError("CONFLICT", "final native prepare has no durable response row; retained reservation forbids re-observation");
  }
  const admitted = admitSemanticChainReplay(finalRoot, closed.path);
  if (admitted.replay.rows[0]?.status !== "replayed") {
    throw new AlayaError("CONFLICT", "final native response failed archive/current-source admission");
  }
  const result = { contract: "source-semantic-recovery-first-exposure-v1", stage_identity: stageIdentity,
    replay_path: closed.path, replay_identity: closed.result.identity, replay_digest: chainIdentity(admitted.replay),
    initial_window_identity: chainIdentity(window), final_publication_identity: final.publication_identity,
    delivered_count: admitted.replay.rows[0]?.response?.operation === "recall"
      ? admitted.replay.rows[0].response.index?.entries.length ?? 0 : 0 };
  writeChainArtifact(exposurePath, result);
  return result;
}
