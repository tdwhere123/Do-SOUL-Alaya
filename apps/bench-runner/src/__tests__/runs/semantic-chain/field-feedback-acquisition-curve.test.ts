import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { chainIdentity } from "../../../runs/semantic-chain/contract.js";
import { freezeRecoveryAllowance } from "../../../runs/semantic-chain/recovery-allowance.js";
import { acquisitionManifest, allowance, CELLS, POINTS, SLOTS, type FrozenCell } from
  "./field-feedback-acquisition-fixture.test-support.js";
import { assessSlot, compareCellCommon, comparePoint, type Assessment } from "./field-feedback-acquisition-assessment.test-support.js";
import { emptyReport, retainJson, runNativeSlot, type NativeReport } from "./field-feedback-acquisition-native.test-support.js";

const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });

function cleanCandidate() {
  const cwd = dirname(fileURLToPath(import.meta.url));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  if (git("status", "--porcelain", "--untracked-files=all") !== "") throw new Error("study requires a clean actual Git worktree");
  const implementation_revision = git("rev-parse", "HEAD"), implementation_tree = git("rev-parse", "HEAD^{tree}");
  if (![implementation_revision, implementation_tree].every(value => /^[a-f0-9]{40}$/u.test(value))) throw new Error("invalid actual Git binding");
  return { implementation_revision, implementation_tree };
}

function absolutePath(name: string): string {
  const value = process.env[name];
  if (value === undefined || !isAbsolute(value)) throw new Error(`${name} must name an absolute parent-provided path`);
  return value;
}

function prepareManifest(filename: string): void {
  const binding = cleanCandidate(), manifest = acquisitionManifest(binding);
  expect(manifest.slots).toHaveLength(64);
  expect(manifest.cells.every(cell => cell.sources.length === 33 && cell.actions.length === 2)).toBe(true);
  writeFileSync(filename, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "wx", flush: true });
  console.info("FIELD_ACQUISITION_MANIFEST " + JSON.stringify({ filename, ...binding, native_calls: 0, slots: 64 }));
}

function retainGuardStop(root: string, reason: string): void {
  const slots = SLOTS.map(slot => ({ slot, execution_status: "not_run", reason,
    endpoints: { public_sufficient_raw: { status: "unknown", reason }, returned_necessary_H: { status: "unknown", reason } } }));
  for (const row of slots) {
    const directory = join(root, row.slot.id); mkdirSync(directory);
    retainJson(directory, "registered.json", row.slot);
    retainJson(directory, "not-run.json", row);
  }
  retainJson(root, "report.json", { slots, comparisons: CELLS.flatMap(cell => POINTS.map(point => ({
    cell, point, paired_common: "unknown", reason,
    comparison: ["A", "B", "M"].map(control => ({ control, outcome: "unknown", reason }))
  }))), guard_failure: reason, native_calls: 0 });
}

async function executeStudy(filename: string, root: string) {
  // Existing roots are terminal evidence. Even a prior interrupted attempt cannot be resumed here.
  mkdirSync(root);
  let frozen: ReturnType<typeof acquisitionManifest>;
  try {
    const binding = cleanCandidate(), expected = acquisitionManifest(binding);
    frozen = JSON.parse(readFileSync(filename, "utf8")) as ReturnType<typeof acquisitionManifest>;
    if (canonicalJson(frozen) !== canonicalJson(expected)) throw new Error("frozen manifest does not match the clean candidate and fixed protocol");
  } catch (error) {
    retainGuardStop(root, String(error));
    throw error;
  }
  retainJson(root, "execution-manifest.json", frozen);
  const reports: NativeReport[] = [], assessments: Assessment[] = [];
  for (const slot of SLOTS) {
    const directory = join(root, slot.id); mkdirSync(directory);
    retainJson(directory, "registered.json", slot);
  }
  const reservationFailures = new Map<string, string>();
  for (const slot of SLOTS) {
    try {
      freezeRecoveryAllowance(join(root, slot.id), chainIdentity({ slot, implementation_revision: frozen.implementation_revision,
        implementation_tree: frozen.implementation_tree }), allowance(slot.point), filename);
    } catch (error) { reservationFailures.set(slot.id, `allowance_initialization_failed: ${String(error)}`); }
  }
  let globalStop: string | null = null;
  for (const slot of SLOTS) {
    const directory = join(root, slot.id), cell = frozen.cells.find(row => row.cell.name === slot.cell.name)!;
    let report = emptyReport(slot);
    const unavailable = globalStop ?? reservationFailures.get(slot.id);
    if (unavailable !== undefined && unavailable !== null) {
      report.status = "not_run"; report.stop = unavailable;
      retainJson(directory, "native-report.json", report);
    } else {
      try {
        const { assessment_only: _oracle, ...commonInput } = cell;
        report = await runNativeSlot(directory, report, commonInput);
      } catch (error) {
        report.status = "native_failure"; report.stop = "uncaught_slot_or_capture_failure"; report.failure = String(error);
        report.native_started = existsSync(join(directory, "attempt-started.json"));
        retainJson(directory, "capture-failure.json", report);
      }
      if (report.protocol_contradiction !== null) globalStop = report.protocol_contradiction;
    }
    reports.push(report);
    try {
      const assessed = assessSlot(report, cell);
      assessments.push(assessed);
      retainJson(directory, "assessment.json", assessed);
    } catch (error) {
      globalStop = `assessment_protocol_failure: ${String(error)}`;
      report.protocol_contradiction = globalStop;
      const assessed = unknownAssessment(report, cell);
      assessments.push(assessed);
      retainJson(directory, "assessment-failure.json", { error: globalStop, assessment: assessed });
    }
    console.info("FIELD_ACQUISITION_SLOT " + JSON.stringify({ slot: slot.id, status: report.status, stop: report.stop,
      raw: assessments.at(-1)!.endpoints.public_sufficient_raw.status, H: assessments.at(-1)!.endpoints.returned_necessary_H.status }));
  }
  try {
    if (canonicalJson(cleanCandidate()) !== canonicalJson({ implementation_revision: frozen.implementation_revision,
      implementation_tree: frozen.implementation_tree })) globalStop = "candidate_changed_during_execution";
  } catch (error) { globalStop = `candidate_guard_failed_after_execution: ${String(error)}`; }
  const cells = CELLS.map(cell => ({ cell, common: compareCellCommon(reports.filter(row => row.slot.cell.name === cell.name)) }));
  const comparisons = cells.flatMap(({ cell, common }) => POINTS.map(point => comparePoint(
    reports.filter(row => row.slot.cell.name === cell.name && row.slot.point.point === point.point),
    assessments.filter(row => row.slot.cell.name === cell.name && row.slot.point.point === point.point), common, globalStop)));
  const outcomes = comparisons.flatMap(row => row.comparison);
  retainJson(root, "report.json", { contract: frozen.contract, implementation_revision: frozen.implementation_revision,
    implementation_tree: frozen.implementation_tree, slots: assessments, cells, comparisons, global_stop: globalStop,
    registered_slots: 64, four_arm_comparisons: 16,
    outcome_counts: Object.fromEntries(["F_win", "tie", "F_loss", "unknown"].map(outcome => [outcome, outcomes.filter(row => row.outcome === outcome).length])),
    positive_claim: globalStop !== null || outcomes.some(row => row.outcome === "unknown") ? "not_established"
      : outcomes.every(row => row.outcome === "tie") ? "closed_for_registered_curve_all_ties" : "requires_full_curve_and_cost_assessment",
    C0: "unknown", U_arm: "unknown", total_lifecycle_cost: "unknown", physical_efficiency: "not_established",
    natural_source_utility: "not_exercised", final_reader: "not_exercised", provider_attempts: 0, default_adoption: "not_authorized" });
  expect(reports).toHaveLength(64); expect(assessments).toHaveLength(64); expect(comparisons).toHaveLength(16);
  expect(globalStop).toBeNull();
}

function unknownAssessment(report: NativeReport, cell: FrozenCell): Assessment {
  // An assessment failure does not change whether the retained native attempt executed.
  return assessSlot({ ...report, common: { ready: false }, access: {},
    stop: report.protocol_contradiction ?? "assessment_failed" }, cell);
}

const mode = process.env.ALAYA_FIELD_ACQUISITION_MODE;
// Preparation and execution are separate invocations. Ordinary test collection consumes no study slot.
it.skipIf(mode === undefined)("retains the complete registered Field acquisition curve without requiring a gain", { timeout: 900_000, retry: 0 }, async () => {
  const filename = absolutePath("ALAYA_FIELD_ACQUISITION_MANIFEST");
  if (mode === "prepare") { prepareManifest(filename); return; }
  if (mode !== "run") throw new Error("ALAYA_FIELD_ACQUISITION_MODE must be prepare or run");
  await executeStudy(filename, absolutePath("ALAYA_FIELD_ACQUISITION_OUTPUT"));
});
