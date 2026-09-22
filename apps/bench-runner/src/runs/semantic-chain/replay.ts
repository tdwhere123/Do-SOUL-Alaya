import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { StorageDatabase, SqliteSourceHintReader } from "@do-soul/alaya-storage";
import { fieldContractSha256, semanticInterpretationEvidenceId, verifyPublishedSourceSemanticInterpretation } from "@do-soul/alaya-core";
import { z } from "zod";
import { canonicalJson, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceSemanticCorrespondence } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { recordSourceSemanticLibraryFirstExposure } from "../measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse } from "../measurement/source-semantic-library-measurement.js";
import { sourceLookupStores } from "../snapshot/source-records/publish.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import { FirstExposurePageSchema } from "../measurement/first-exposure-session.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainArtifact,
  assertChainSnapshot, withSemanticChainDaemon } from "./contract.js";
import type { SourceSemanticCorrespondenceRequest } from "@do-soul/alaya-soul";
import { readSemanticChainCorrespondences, verifySemanticChainQueries } from "./inputs.js";

export async function replaySemanticChain(root: string, arm: "retained" | "without_semantic_correspondences" = "retained") {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const config = plan.config;
  assertChainSnapshot(config);
  verifySemanticChainQueries(plan);
  const { semantic_correspondences, identity } = readSemanticChainCorrespondences(plan, arm);
  const output = join(root, `replay-${identity}.json`);
  return withSnapshotPublishLock(output, async () => {
    const retained = readChainArtifact(output);
    if (retained !== undefined) return { path: output, result: retained };
    const rows: unknown[] = [];
    if (plan.queries.every((query) => query.status === "blocked")) rows.push(...plan.queries);
    else await withSemanticChainDaemon(config, root, async (daemon) => {
      for (const query of plan.queries) {
        if (query.status === "blocked") { rows.push(query); continue; }
        const ready: SourceSemanticCorrespondence[] = [];
        const outcomes = query.descriptors.map((descriptor) => {
          const found = semantic_correspondences.find((row) => {
            const request = row.line.request as SourceSemanticCorrespondenceRequest;
            return row.line.original_query === query.original_query &&
              request.source_interpretation_descriptors[0]?.source_interpretation_id === descriptor.interpretation_id &&
              canonicalJson(request.admitted_query_semantics) === canonicalJson(query.query_semantics);
          });
          if (found?.received !== undefined && "semantic_correspondence" in found.received && found.received.semantic_correspondence !== undefined) {
            ready.push(found.received.semantic_correspondence);
          }
          return { source_interpretation_id: descriptor.interpretation_id, status: found?.status ?? "unattempted",
            reason: query.selected_source_interpretation_ids.includes(descriptor.interpretation_id) ? "selected" : "correspondence_pair_cap",
            key: found?.line.key ?? null, raw_digest: found?.shard?.raw_digest ?? null };
        });
        const rowPath = join(root, `replay-${identity}`, `${query.query_key}.json`);
        const prior = readChainArtifact(rowPath);
        if (prior !== undefined) { rows.push(prior); continue; }
        const reservation = `${rowPath}.reserved`;
        if (readChainArtifact(reservation) !== undefined) {
          throw new Error("native first exposure is unresolved after interruption; retained reservation forbids re-exposure");
        }
        writeChainArtifact(reservation, { replay_identity: identity, query_key: query.query_key });
        const started = performance.now();
        const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
          SoulInterpretationRequestSchema.parse({ operation: "recall", original_query: query.original_query, query_semantics: query.query_semantics,
            semantic_correspondences: arm === "retained" ? ready : [], accepts_unreviewed_conditional_results: true,
            budget: config.budget, output_byte_limit: config.output_byte_limit, authorized_scopes: config.authorized_scopes })));
        if (response.operation !== "recall") throw new Error("native recall returned a different operation");
        const exposure = response.index === undefined || response.delivery_id === undefined ? null
          : recordSourceSemanticLibraryFirstExposure(response);
        const row = { query_key: query.query_key, status: exposure === null ? "native_unavailable" : "replayed",
          correspondence_outcomes: outcomes, response, first_exposure: exposure, native_elapsed_ms: performance.now() - started };
        writeChainArtifact(rowPath, row); rows.push(row);
      }
    });
    const result = { contract: "source-semantic-chain-replay-v2", plan_identity: chainIdentity(plan),
      identity, arm, provider_calls: 0, rows };
    writeChainArtifact(output, result);
    return { path: output, result };
  });
}

export function measureSemanticChain(root: string, replayPath: string, goldValue: unknown) {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const replay = z.object({ contract: z.literal("source-semantic-chain-replay-v2"),
    plan_identity: z.string(), identity: z.string(), rows: z.array(z.object({
      query_key: z.string(), status: z.enum(["blocked", "replayed", "native_unavailable"]),
      reason: z.string().optional(), native_elapsed_ms: z.number().nonnegative().optional(),
      response: SoulInterpretationResponseSchema.optional(), first_exposure: FirstExposurePageSchema.nullable().optional()
    }).passthrough()) }).passthrough().parse(readChainArtifact(replayPath));
  if (replay.contract !== "source-semantic-chain-replay-v2" || replay.plan_identity !== chainIdentity(plan)) {
    throw new Error("measurement replay does not bind this plan");
  }
  const gold = z.array(z.object({ query_key: z.string(), source_units: SourceGoldUnitSchema.array() }).strict()).parse(goldValue);
  const expected = plan.queries.map((row) => row.query_key).sort();
  if (canonicalJson(expected) !== canonicalJson(gold.map((row) => row.query_key).sort()) ||
      canonicalJson(expected) !== canonicalJson(replay.rows.map((row) => row.query_key).sort())) {
    throw new Error("measurement requires exact per-query gold and replay denominator coverage");
  }
  assertChainSnapshot(plan.config);
  const connection = new BetterSqlite3(plan.config.snapshot_path, { readonly: true, fileMustExist: true });
  let sourceRecords;
  try {
    connection.pragma("query_only = ON");
    const database = new StorageDatabase(plan.config.snapshot_path, connection);
    const stores = sourceLookupStores(database);
    const reader = new SqliteSourceHintReader(connection);
    sourceRecords = replay.rows.flatMap((row) => row.response?.operation === "recall" ? row.response.proofs ?? [] : []).flatMap((proof) => {
      try {
        const retained = reader.readBoundInterpretation(plan.config.workspace_id,
          semanticInterpretationEvidenceId(proof.source_interpretation_id!, fieldContractSha256), 1_000_000);
        if (retained.status !== "complete" || retained.gist === null) return [];
        return [verifyPublishedSourceSemanticInterpretation({ stores, sha256: fieldContractSha256 },
          JSON.parse(retained.gist), plan.config.workspace_id).stored.record];
      } catch { return []; }
    });
  } finally { connection.close(); }
  const rows = replay.rows.map((row) => ({ query_key: row.query_key, status: row.status,
    reason: row.reason ?? null,
    diagnostics: row.response?.operation === "recall" ? {
      discovery: row.response.discovery, coverage: row.response.coverage, work: row.response.work,
      delivered_results: row.response.results?.length ?? 0, delivered_proofs: row.response.proofs?.length ?? 0,
      native_elapsed_ms: row.native_elapsed_ms ?? null
    } : null,
    measurement: row.first_exposure == null ? null : measureSourceSemanticLibraryResponse({
      recallResult: row.response, firstExposurePage: row.first_exposure,
      requestBudget: plan.config.budget, sourceRecords: sourceRecords.filter((record) => row.response?.operation === "recall"
        && row.response.proofs?.some((proof) => proof.source_record.identity === record.identity)), goldSourceUnits: gold.find((entry) => entry.query_key === row.query_key)!.source_units
    }) }));
  const result = { contract: "source-semantic-chain-measurement-v1", replay_identity: replay.identity, gold, rows };
  const path = join(root, `measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result);
  return { path, result };
}
