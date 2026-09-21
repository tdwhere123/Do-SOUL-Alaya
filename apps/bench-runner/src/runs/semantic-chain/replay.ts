import { join } from "node:path";
import { z } from "zod";
import { canonicalJson, SoulInterpretationRequestSchema, SoulInterpretationResponseSchema,
  type SourceSemanticAlignment } from "@do-soul/alaya-protocol";
import { callMcpTool } from "../../harness/daemon/runtime/daemon-mcp-support.js";
import { withSnapshotPublishLock } from "../snapshot/freeze/publish-lock.js";
import { recordSourceSemanticLibraryFirstExposure } from "../measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse } from "../measurement/source-semantic-library-measurement.js";
import { SourceGoldUnitSchema } from "../measurement/source-gold-join.js";
import { FirstExposurePageSchema } from "../measurement/first-exposure-session.js";
import { SemanticChainPlanSchema, chainIdentity, readChainArtifact, writeChainArtifact,
  assertChainSnapshot, withSemanticChainDaemon } from "./contract.js";
import type { SourceSemanticAlignmentRequest } from "@do-soul/alaya-soul";
import { readSemanticChainAlignments, verifySemanticChainQueries } from "./inputs.js";

export async function replaySemanticChain(root: string, arm: "retained" | "without_alignments" = "retained") {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const config = plan.config;
  assertChainSnapshot(config);
  verifySemanticChainQueries(plan);
  const { alignments, identity } = readSemanticChainAlignments(plan, arm);
  const output = join(root, `replay-${identity}.json`);
  return withSnapshotPublishLock(output, async () => {
    const retained = readChainArtifact(output);
    if (retained !== undefined) return { path: output, result: retained };
    const rows: unknown[] = [];
    if (plan.queries.every((query) => query.status === "blocked")) rows.push(...plan.queries);
    else await withSemanticChainDaemon(config, root, async (daemon) => {
      for (const query of plan.queries) {
        if (query.status === "blocked") { rows.push(query); continue; }
        const ready: SourceSemanticAlignment[] = [];
        const outcomes = query.descriptors.map((descriptor) => {
          const found = alignments.find((row) => {
            const request = row.line.request as SourceSemanticAlignmentRequest;
            return row.line.original_query === query.original_query &&
              request.h_descriptors[0]?.h_id === descriptor.interpretation_id &&
              canonicalJson(request.admitted_q) === canonicalJson(query.q);
          });
          if (found?.received !== undefined && "alignment" in found.received && found.received.alignment !== undefined) {
            ready.push(found.received.alignment);
          }
          return { h_id: descriptor.interpretation_id, status: found?.status ?? "unattempted",
            reason: query.selected_h_ids.includes(descriptor.interpretation_id) ? "selected" : "alignment_pair_cap",
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
        const response = SoulInterpretationResponseSchema.parse(await callMcpTool(daemon.mcpClient, "soul.interpretation",
          SoulInterpretationRequestSchema.parse({ operation: "recall", original_query: query.original_query, q: query.q,
            alignments: arm === "retained" ? ready : [], accepts_unreviewed_conditional_results: true,
            budget: config.budget, output_byte_limit: config.output_byte_limit, authorized_scopes: config.authorized_scopes })));
        if (response.operation !== "recall") throw new Error("native recall returned a different operation");
        const exposure = response.index === undefined || response.delivery_id === undefined ? null
          : recordSourceSemanticLibraryFirstExposure(response);
        const row = { query_key: query.query_key, status: exposure === null ? "native_unavailable" : "replayed",
          alignment_outcomes: outcomes, response, first_exposure: exposure };
        writeChainArtifact(rowPath, row); rows.push(row);
      }
    });
    const result = { contract: "source-semantic-chain-replay-v1", plan_identity: chainIdentity(plan),
      identity, arm, provider_calls: 0, rows };
    writeChainArtifact(output, result);
    return { path: output, result };
  });
}

export function measureSemanticChain(root: string, replayPath: string, goldValue: unknown) {
  const plan = SemanticChainPlanSchema.parse(readChainArtifact(join(root, "prepare.json")));
  const replay = z.object({ contract: z.literal("source-semantic-chain-replay-v1"),
    plan_identity: z.string(), identity: z.string(), rows: z.array(z.object({
      query_key: z.string(), status: z.enum(["blocked", "replayed", "native_unavailable"]),
      response: SoulInterpretationResponseSchema.optional(), first_exposure: FirstExposurePageSchema.nullable().optional()
    }).passthrough()) }).passthrough().parse(readChainArtifact(replayPath));
  if (replay.contract !== "source-semantic-chain-replay-v1" || replay.plan_identity !== chainIdentity(plan)) {
    throw new Error("measurement replay does not bind this plan");
  }
  const gold = z.array(z.object({ query_key: z.string(), source_units: SourceGoldUnitSchema.array() }).strict()).parse(goldValue);
  const expected = plan.queries.map((row) => row.query_key).sort();
  if (canonicalJson(expected) !== canonicalJson(gold.map((row) => row.query_key).sort()) ||
      canonicalJson(expected) !== canonicalJson(replay.rows.map((row) => row.query_key).sort())) {
    throw new Error("measurement requires exact per-query gold and replay denominator coverage");
  }
  const rows = replay.rows.map((row) => ({ query_key: row.query_key, status: row.status,
    measurement: row.first_exposure == null ? null : measureSourceSemanticLibraryResponse({
      recallResult: row.response, firstExposurePage: row.first_exposure,
      requestBudget: plan.config.budget, goldSourceUnits: gold.find((entry) => entry.query_key === row.query_key)!.source_units
    }) }));
  const result = { contract: "source-semantic-chain-measurement-v1", replay_identity: replay.identity, gold, rows };
  const path = join(root, `measurement-${chainIdentity(result)}.json`);
  writeChainArtifact(path, result);
  return { path, result };
}
