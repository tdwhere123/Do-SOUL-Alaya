import { hashSourceRecordId } from "@do-soul/alaya-protocol";
import { fieldContractSha256, sourceSemanticLibraryQueryIdentity } from "@do-soul/alaya-core";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { recordSourceSemanticLibraryFirstExposure } from "../../../runs/measurement/source-semantic-library-recall.js";
import { measureSourceSemanticLibraryResponse } from "../../../runs/measurement/source-semantic-library-measurement.js";
import { sourceGoldUnitFromPublishedRoot } from "../../../runs/measurement/source-gold-join.js";
import { REQUEST, CLOCK, DIGEST, sourceOnly, assemble, workerRecall } from "./source-semantic-library-measurement-fixture.js";

export const envelope = <T>(payload: T) => ({ identity: chainIdentity(payload), payload });

/** Entirely authored native-envelope evidence; no model result or private history is a test input. */
export function frozenUnionFixture(openAccessAt?: number) {
  const inventory = Array.from({ length: 500 }, (_, index) => ({ index, question_id: `question-${index}`,
    cohort: index < 470 ? "answerable" as const : "abstention" as const }));
  const source = { source_id: "source-one", source_version: "1", content_digest: DIGEST,
    corpus_digest: DIGEST.slice(7), session_id: "session-one", session_index: 0, round_index: 0,
    source_observed_at: CLOCK, roles: ["user" as const] };
  const root = hashSourceRecordId(source, fieldContractSha256);
  const selected = inventory.slice(0, 20).map((row) => ({ ...row, question: `Find evidence ${row.index}`,
    question_date: CLOCK, interpretation_clock: CLOCK, query_key: fieldContractSha256(`query-${row.index}`), source_manifest: [source] }));
  const freeze = envelope({ contract: "longmemeval-semantic-development-v1", config: {
    data_dir: "/authored/data", pinned_meta_root: "/authored/meta", dataset_sha256: "ab".repeat(32), dataset_question_count: 500,
    question_ids: selected.map((row) => row.question_id), model: "authored", request_profile: "gemini-3.1-minimal-v1",
    query_cache_root: "/authored/cache", recorded_at: CLOCK, producer_commit: "a".repeat(40), budget: REQUEST,
    output_byte_limit: 1_000_000, max_output_tokens: 4096
  }, implementation_revision: "authored", metric: "session-bearing-source-round-mixed-any-at-5",
  order_policy: "native_canonical_source_root_order", mechanism: "source_only_h_a_not_exercised", exposure: "development_exposed",
  inventory, selected, query_workset: { contract: "source-semantic-proposal-workset-v2", kind: "query", model: "authored",
    request_profile: "gemini-3.1-minimal-v1", items: selected.map((row) => ({ original_query: row.question })) } });
  const files = new Map<string, string>();
  const put = (path: string, payload: unknown) => { files.set(path, JSON.stringify(envelope(payload))); return chainIdentity(payload); };
  const measurementPaths: string[] = [];
  const preparedRows = selected.map((row) => {
    const chain_root = `/authored/${row.index}/chain`, publication_path = `/authored/${row.index}/publication.json`;
    const workspace = `longmemeval-semantic-${row.index}`;
    const publication = { workspace_id: workspace, run_id: workspace, recorded_at: CLOCK, snapshot_path: `/authored/${row.index}/library.sqlite`,
      db_sha256: "cd".repeat(32), census_count: 1, admitted_count: 1, published_count: 0,
      sources: [{ ...source, question_id: row.question_id, admission: "admitted", record_id: root }] };
    const publication_identity = put(publication_path, publication);
    const plan = { config: { snapshot_sha256: publication.db_sha256, snapshot_path: publication.snapshot_path,
      workspace_id: workspace, run_id: workspace, interpretation_clock: CLOCK, budget: REQUEST,
      implementation_revision: freeze.payload.implementation_revision, output_byte_limit: freeze.payload.config.output_byte_limit,
      max_output_tokens: freeze.payload.config.max_output_tokens, query_cache_root: freeze.payload.config.query_cache_root,
      query_workset: { ...freeze.payload.query_workset, items: [freeze.payload.query_workset.items[row.index]] } },
      queries: [{ query_key: row.query_key, original_query: row.question }] };
    const plan_identity = put(`${chain_root}/prepare.json`, plan);
    const recalled = workerRecall({ ...assemble([sourceOnly(row.index < 3 ? root : "distractor", workspace)], []),
      query_id: sourceSemanticLibraryQueryIdentity(row.question) });
    const result = row.index === openAccessAt
      ? { ...recalled, discovery: { ...recalled.discovery, open_residuals: true, truncated: true } } : recalled;
    const first_exposure = recordSourceSemanticLibraryFirstExposure(result);
    const gold = [sourceGoldUnitFromPublishedRoot({ ...sourceOnly(root, workspace).target, kind: "source_evidence" } as Parameters<typeof sourceGoldUnitFromPublishedRoot>[0])];
    const measurement = row.index < 8 ? measureSourceSemanticLibraryResponse({ recallResult: result,
      firstExposurePage: first_exposure, requestBudget: REQUEST, goldSourceUnits: gold }).measurement : null;
    const replay = { contract: "source-semantic-chain-replay-v1", plan_identity, identity: `replay-${row.index}`, provider_calls: 0,
      rows: [{ query_key: row.query_key, response: result, first_exposure }] };
    put(`${chain_root}/replay.json`, replay);
    const measured = { contract: "source-semantic-chain-measurement-v1", replay_identity: replay.identity,
      gold: [{ query_key: row.query_key, source_units: gold }], rows: [{ query_key: row.query_key, measurement }] };
    const path = `${chain_root}/measurement-${chainIdentity(measured)}.json`;
    put(path, measured); measurementPaths.push(path);
    return { question_id: row.question_id, status: "prepared" as const, chain_root, publication_path, publication_identity };
  });
  const prepared = envelope({ contract: "longmemeval-semantic-prepared-v1", freeze_identity: freeze.identity, rows: preparedRows });
  const replay = envelope({ contract: "longmemeval-semantic-replay-v1", freeze_identity: freeze.identity,
    prepared_identity: prepared.identity, provider_calls: 0, rows: preparedRows.map((row) => ({ ...row, status: "replayed", replay_path: `${row.chain_root}/replay.json` })) });
  const summary = envelope({ contract: "longmemeval-semantic-measurement-v1", freeze_identity: freeze.identity,
    replay_identity: replay.identity, dataset_sha256: freeze.payload.config.dataset_sha256, provider_calls: 0,
    inventory: { questions: 500, answerable: 470, abstention: 30 }, primary: { eligible: 20, hits: 3, misses: 5, unknown: 12 },
    formal_target: { eligible: 470 }, rows: inventory.map((row) => ({ ...row, selected: row.index < 20,
      outcome: row.index < 3 ? "hit" : row.index < 8 ? "miss" : row.index < 20 ? "unknown" : "not_selected_development",
      measurement_path: measurementPaths[row.index] ?? null, reason: row.index < 8 ? null : "native_measurement_unavailable" })) });
  return { evidence: { freeze, prepared, replay, summary }, files,
    read: (path: string) => { const text = files.get(path); if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return text; } };
}
