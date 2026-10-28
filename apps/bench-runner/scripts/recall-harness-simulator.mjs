#!/usr/bin/env node
// Offline screening only. No label is read until every captured native row has passed parity.
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { AlayaError } from "@do-soul/alaya-protocol";
import { scoreRecallHarnessRow } from "./recall-harness-score.mjs";
import { observedAccessOrder, simulateRecallDelivery } from "./recall-simulator-delivery.mjs";
import { preparePolicyInputs, selectPolicy } from "./recall-simulator-policies.mjs";
import { withRecallSnapshot } from "./recall-bound-snapshot.mjs";
import { readCurrentExtractionAuthorityRevision } from "../dist/runs/extraction/authority/inspection.js";

const METRICS = ["msg5", "msg10", "root5", "root10", "b2048", "b4096", "b8192"];
const KINDS = ["any", "all"];
const DATASETS = resolve(dirname(fileURLToPath(import.meta.url)), "../../../docs/bench-history/datasets");

async function readRows(path) {
  const rows = [];
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

function uniqueRows(rows, arm, count, label) {
  const selected = arm === undefined ? rows : rows.filter(row => row.arm === arm);
  if (selected.length !== count) throw new AlayaError("VALIDATION", `${label}: expected ${count} rows, found ${selected.length}`);
  const result = new Map();
  for (const row of selected) {
    if (result.has(row.question_id)) throw new AlayaError("CONFLICT", `${label}: duplicate question ${row.question_id}`);
    result.set(row.question_id, row);
  }
  return result;
}

function sameIntervals(left, right) { return isDeepStrictEqual(left, right); }

export function assertPairedScreenInputs(row, expected) {
  if (typeof row.input_identity !== "string" || !row.input_identity || row.input_identity !== expected.input_identity
    || typeof row.arm_identity !== "string" || !row.arm_identity || row.arm_identity !== expected.arm_identity
    || row.initial_request == null || !isDeepStrictEqual(row.initial_request, expected.initial_request)
    || row.snapshot_identity == null || !isDeepStrictEqual(row.snapshot_identity, expected.snapshot_identity)
    || typeof row.snapshot_sha256 !== "string" || row.snapshot_sha256 !== expected.snapshot_sha256) {
    throw new AlayaError("CONFLICT", "capture and plain baseline do not bind the same inputs");
  }
}

/** Exact one-sided paired sign probability under a symmetric null. */
export function signTest(wins, losses) {
  const n = wins + losses;
  let probability = 2 ** -n, tail = 0;
  for (let k = 0; k <= n; k++) {
    if (k >= wins) tail += probability;
    probability *= (n - k) / (k + 1);
  }
  return Math.min(1, tail);
}

function early(row, capture) {
  const facts = [...capture.pool.map(item => item.host), ...(capture.diagnostic_beyond_allowance?.siblings ?? [])];
  const byId = new Map(facts.filter(Boolean).map(fact => [fact.root_id, fact]));
  const prefix = row.intervals.filter(interval => interval.slot_index < 5 && interval.span !== null);
  const known = prefix.filter(interval => byId.get(interval.target.root_id)?.round != null);
  return { first_round: known.filter(interval => byId.get(interval.target.root_id).round === 0).length,
    slots: prefix.length, unknown: prefix.length - known.length };
}

export function aggregate(scored, rows, captureById) {
  const answerable = scored.filter(row => row.gold > 0), usable = answerable.filter(row => row.scored);
  const counts = Object.fromEntries(METRICS.map(metric => [metric, Object.fromEntries(KINDS.map(kind =>
    [kind, usable.filter(row => row[metric]?.[kind] === true).length]))]));
  const byType = {};
  for (const type of new Set(scored.map(row => row.question_type))) {
    const own = usable.filter(row => row.question_type === type);
    byType[type] = { total: scored.filter(row => row.question_type === type).length, scored: own.length,
      metrics: Object.fromEntries(METRICS.map(metric => [metric, Object.fromEntries(KINDS.map(kind =>
        [kind, own.filter(row => row[metric]?.[kind] === true).length]))])) };
  }
  const first = rows.filter(row => row.status !== "unavailable" && Array.isArray(row.intervals))
    .map(row => early(row, captureById.get(row.question_id).pool_capture));
  const firstRound = first.reduce((sum, row) => sum + row.first_round, 0), slots = first.reduce((sum, row) => sum + row.slots, 0);
  const unknown = first.reduce((sum, row) => sum + row.unknown, 0), known = slots - unknown;
  return { total: scored.length, scored: usable.length, failed: answerable.length - usable.length,
    gold_zero: scored.filter(row => row.gold === 0).length, counts, by_type: byType,
    early_first_five: { first_round: firstRound, slots, known, unknown,
      share: slots === 0 || unknown > 0 ? null : firstRound / slots,
      known_share: known === 0 ? null : firstRound / known,
      lower_bound: slots === 0 ? null : firstRound / slots,
      upper_bound: slots === 0 ? null : (firstRound + unknown) / slots } };
}

function paired(baseRows, rows) {
  const base = new Map(baseRows.filter(row => row.scored).map(row => [row.question_id, row]));
  const pairs = rows.filter(row => row.scored && base.has(row.question_id));
  return Object.fromEntries(METRICS.map(metric => [metric, Object.fromEntries(KINDS.map(kind => {
    const wins = pairs.filter(row => row[metric][kind] && !base.get(row.question_id)[metric][kind]).map(row => row.question_id);
    const losses = pairs.filter(row => !row[metric][kind] && base.get(row.question_id)[metric][kind]).map(row => row.question_id);
    return [kind, { pairs: pairs.length, wins, losses, one_sided_exact_p: signTest(wins.length, losses.length) }];
  }))]));
}

export async function runRecallSimulation(options) {
  const mode = options.mode ?? "screen", cohort = options.cohort ?? "original100";
  if (!["screen", "verify"].includes(mode)) throw new AlayaError("VALIDATION", "unknown simulator mode");
  if (mode === "verify" && (options.policies?.length ?? 0) > 0) throw new AlayaError("VALIDATION", "verification mode cannot score policies");
  if (mode === "screen" && options.expectedCount !== undefined) throw new AlayaError("VALIDATION", "screening cannot override cohort size");
  if (realpathSync(options.capture) === realpathSync(options.baseline)) throw new AlayaError("CONFLICT", "capture and S1 must be independent files");
  let manifest = null;
  if (mode === "screen") {
    if (!["original100", "dev2"].includes(cohort)) throw new AlayaError("VALIDATION", "unknown screening cohort");
    const name = cohort === "original100" ? "longmemeval_s.stratified-100.v1.json" : "longmemeval_s.dev2-288.v1.json";
    manifest = JSON.parse(readFileSync(join(DATASETS, name), "utf8"));
    const size = cohort === "original100" ? 100 : 288;
    if (manifest.target_count !== size || manifest.question_ids?.length !== size || new Set(manifest.question_ids).size !== size) {
      throw new AlayaError("VALIDATION", "invalid frozen screening cohort");
    }
  }
  const count = manifest?.target_count ?? options.expectedCount ?? 100, out = resolve(options.out);
  if (!Number.isSafeInteger(count) || count < 1) throw new AlayaError("VALIDATION", "expected question count must be a positive integer");
  if (existsSync(out)) throw new AlayaError("CONFLICT", "simulator requires a fresh output directory");
  const capture = uniqueRows(await readRows(options.capture), options.captureArm, count, "capture");
  const baseline = uniqueRows(await readRows(options.baseline), options.baselineArm, count, "baseline");
  if ([...capture.keys()].some(id => !baseline.has(id))) throw new AlayaError("CONFLICT", "capture and S1 question membership differs");
  let revision = null;
  if (manifest !== null) {
    if (manifest.question_ids.some(id => !capture.has(id))) throw new AlayaError("CONFLICT", "rows do not match the frozen screening cohort");
    if ([...capture.values()].some(row => row.capture_requested !== true)
      || [...baseline.values()].some(row => row.capture_requested === true)) throw new AlayaError("CONFLICT", "capture and plain S1 roles are not independent");
    const revisions = new Set([...capture.values()].map(row => row.implementation_revision));
    if (revisions.size !== 1 || typeof [...revisions][0] !== "string" || ![...revisions][0]) {
      throw new AlayaError("CONFLICT", "capture implementation revision is missing or mixed");
    }
    revision = [...revisions][0];
    if (revision !== readCurrentExtractionAuthorityRevision()) throw new AlayaError("CONFLICT", "capture revision does not match the loaded simulator checkout");
    if ([...baseline.values()].some(row => row.implementation_revision !== revision)) {
      throw new AlayaError("CONFLICT", "plain baseline revision is missing or differs from the capture candidate");
    }
    if (cohort === "dev2") {
      if (!options.referenceParity) throw new AlayaError("VALIDATION", "Dev2 requires the independent Original100 parity report");
      const reference = JSON.parse(readFileSync(options.referenceParity, "utf8"));
      if (reference.authorization !== "original100" || reference.expected !== 100 || reference.matched !== 100
        || reference.implementation_revision !== revision) throw new AlayaError("CONFLICT", "Original100 parity does not authorize this candidate");
    }
  }
  mkdirSync(out, { recursive: true });
  const parity = [], nativeRows = [];
  for (const [id, row] of capture) {
    const expected = baseline.get(id);
    try {
      if (row.status !== "complete" || expected.status !== "complete" || row.pool_capture?.status !== "captured") {
        throw new AlayaError("UNAVAILABLE", "capture or baseline incomplete");
      }
      if (row.question_type !== expected.question_type || row.workspace !== expected.workspace) {
        throw new AlayaError("CONFLICT", "capture and S1 question identity differ");
      }
      if (manifest !== null) {
        assertPairedScreenInputs(row, expected);
        withRecallSnapshot(expected, () => undefined);
      }
      if (!sameIntervals(row.intervals, expected.intervals)) throw new AlayaError("CONFLICT", "capture arm differs from S1 intervals");
      const order = observedAccessOrder(row.pool_capture);
      const delivery = simulateRecallDelivery(row, order);
      if (!sameIntervals(delivery.intervals, expected.intervals)) throw new AlayaError("CONFLICT", "production encoder replay differs from S1 intervals");
      parity.push({ question_id: id, status: "matched" });
      nativeRows.push({ question_id: id, question_type: row.question_type, arm: "native", status: "counterfactual",
        snapshot: row.snapshot, snapshot_sha256: row.snapshot_sha256, workspace: row.workspace,
        intervals: delivery.intervals, pages: delivery.pages });
    } catch (error) { parity.push({ question_id: id, status: "failed", reason: error instanceof Error ? error.message : String(error) }); }
  }
  const matched = parity.filter(row => row.status === "matched").length;
  const authorization = mode === "screen" && matched === count ? cohort : "none";
  writeFileSync(join(out, "parity.json"), JSON.stringify({ expected: count, matched, authorization,
    implementation_revision: revision, capture: realpathSync(options.capture), baseline: realpathSync(options.baseline),
    capture_arm: options.captureArm ?? null, baseline_arm: options.baselineArm ?? null, rows: parity }, null, 2) + "\n");
  if (matched !== count) throw new AlayaError("CONFLICT", `native parity failed: ${matched}/${count}; no policies were scored`);
  if (mode === "verify") return { parity, authorization: "none" };

  // Policies receive only captured observations and optional question/source representations.
  const policies = options.policies ?? [], inputs = await preparePolicyInputs(capture, options);
  const outputRows = [...nativeRows], details = [];
  for (const name of policies) for (const native of nativeRows) {
    const source = capture.get(native.question_id);
    try {
      const choice = await selectPolicy(name, source, native, inputs);
      if (choice.status !== "ready") {
        outputRows.push({ ...native, arm: name, status: "unavailable", error: choice.reason });
        details.push({ question_id: native.question_id, arm: name, status: "unavailable", reason: choice.reason });
        continue;
      }
      const delivery = simulateRecallDelivery(source, choice.order, choice.display);
      outputRows.push({ ...native, arm: name, intervals: delivery.intervals, pages: delivery.pages,
        ...(choice.features === undefined ? {} : { policy_diagnostics: choice.features }) });
      details.push({ question_id: native.question_id, arm: name, status: "screened", scope: choice.scope,
        metadata_scope: delivery.metadata_scope, native_work: "not_measured" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      outputRows.push({ ...native, arm: name, status: "unavailable", error: reason });
      details.push({ question_id: native.question_id, arm: name, status: "unavailable", reason });
    }
  }

  const datasetBytes = readFileSync(options.dataset);
  if (createHash("sha256").update(datasetBytes).digest("hex") !== manifest.dataset_sha256) {
    throw new AlayaError("CONFLICT", "scoring dataset does not match the frozen cohort");
  }
  const dataset = new Map(JSON.parse(datasetBytes.toString("utf8")).map(question => [question.question_id, question]));
  const scored = outputRows.map(row => row.status === "unavailable" ? scoreRecallHarnessRow(row, dataset)
    : withRecallSnapshot(row, snapshot => scoreRecallHarnessRow({ ...row, snapshot }, dataset)));
  const arms = ["native", ...policies], nativeScores = scored.filter(row => row.arm === "native");
  const summaries = Object.fromEntries(arms.map(arm => {
    const scores = scored.filter(row => row.arm === arm), rows = outputRows.filter(row => row.arm === arm);
    return [arm, { ...aggregate(scores, rows, capture), ...(arm === "native" ? {} : { paired: paired(nativeScores, scores) }) }];
  }));
  const conflicts = options.conflicts ? JSON.parse(readFileSync(options.conflicts, "utf8")) : null;
  writeFileSync(join(out, "rows.jsonl"), outputRows.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(out, "scores.jsonl"), scored.map(row => JSON.stringify(row)).join("\n") + "\n");
  writeFileSync(join(out, "summary.json"), JSON.stringify({ parity: { expected: count, matched },
    scope: "offline production-encoder screening; native policy claims require native measurement",
    label_conflicts: conflicts === null ? { status: "not_supplied", annotations: null }
      : { status: "supplied", annotations: conflicts }, arms: summaries, details }, null, 2) + "\n");
  return { parity, summaries, details };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const { values } = parseArgs({ options: {
    capture: { type: "string" }, baseline: { type: "string" }, out: { type: "string" }, dataset: { type: "string" },
    "capture-arm": { type: "string" }, "baseline-arm": { type: "string" }, "expected-count": { type: "string" },
    mode: { type: "string" }, cohort: { type: "string" }, "reference-parity": { type: "string" },
    policies: { type: "string" }, coordinates: { type: "string" }, statements: { type: "string" },
    "vector-cache": { type: "string" }, conflicts: { type: "string" }
  } });
  if (!values.capture || !values.baseline || !values.out) throw new AlayaError("VALIDATION", "--capture, --baseline and --out are required");
  await runRecallSimulation({ capture: resolve(values.capture), baseline: resolve(values.baseline), out: values.out,
    dataset: resolve(values.dataset ?? join(dirname(fileURLToPath(import.meta.url)), "../data/longmemeval/longmemeval_s.json")),
    captureArm: values["capture-arm"], baselineArm: values["baseline-arm"],
    mode: values.mode, cohort: values.cohort, referenceParity: values["reference-parity"],
    expectedCount: values["expected-count"] === undefined ? undefined : Number(values["expected-count"]),
    policies: values.policies ? values.policies.split(",") : [], coordinates: values.coordinates,
    statements: values.statements, vectorCache: values["vector-cache"], conflicts: values.conflicts });
}
