import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it, vi } from "vitest";
import { SourceRecordIdentitySchema } from "@do-soul/alaya-protocol";
import { readRetainedEvidence, RetainedConsumerLedger, RETAINED_CONSUMER_BUDGET,
  type EvaluatorCompatibilityPremise, type RetainedConsumerPacket } from "./retained-evidence-consumer.test-support.js";

const isolation = await vi.hoisted(async () => {
  if (process.env["ALAYA_RETAINED_EVIDENCE_CONSUMER"] !== "1") return undefined;
  const { installProviderFreeBoundary } = await import("../../../../../bench-runner/src/__tests__/support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation?.restore(); if (isolation !== undefined) expect(isolation.violations).toEqual([]); });

const enabled = process.env["ALAYA_RETAINED_EVIDENCE_CONSUMER"] === "1";
const queryId = "sha256:fcf749a7197481ca5d865d2146ed2f2dbf9b208e473ef3bf332a5b10d5fd8f1e";
const windows = [
  { directory: "singleton-exchange-window/native-singleton-exchange", response: "candidate.full.json", nested: true },
  { directory: "real-page-window/native-page-cardinality", response: "policy.delivered.json", nested: false }
] as const;
type Configuration = ReturnType<typeof configuration>;
type ArtifactRead = { path: string; bytes: number; status: "started" | "decoded" };

function configuration() {
  const required = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required for the opt-in diagnostic`);
    return value;
  };
  const root = required("ALAYA_RETAINED_EVIDENCE_REPORT_DIR"), inputs = required("ALAYA_RETAINED_EVIDENCE_INPUT_ROOT");
  const sha = required("ALAYA_RETAINED_EVIDENCE_CONSUMER_SHA"), tree = required("ALAYA_RETAINED_EVIDENCE_CONSUMER_TREE");
  if (![sha, tree].every(value => /^[a-f0-9]{40}$/u.test(value))) throw new Error("exact candidate SHA and tree required");
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(dirname(root)) !== dirname(root)) {
    throw new Error("report directory must be fresh and canonical with an existing parent");
  }
  if (!isAbsolute(inputs) || realpathSync(inputs) !== inputs
    || !inputs.endsWith("/.do-it/bench-runs/native-chain/evidence-selection")) throw new Error("retained selection input root required");
  const location = relative(inputs, root);
  if (location === "" || !isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`)) {
    throw new Error("output must stay outside the retained input directory");
  }
  mkdirSync(root);
  return { root, inputs, sha, tree, worktree: realpathSync(fileURLToPath(new URL("../../../../../../", import.meta.url))) };
}

function frozenCandidate(config: Configuration) {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: config.worktree, encoding: "utf8" }).trim();
  const observed = { root: realpathSync(git("rev-parse", "--show-toplevel")), sha: git("rev-parse", "HEAD"),
    tree: git("rev-parse", "HEAD^{tree}"), status: git("status", "--porcelain=v1", "--untracked-files=all") };
  if (observed.root !== config.worktree || observed.sha !== config.sha || observed.tree !== config.tree || observed.status !== "") {
    throw new Error(`candidate guard failed: ${JSON.stringify(observed)}`);
  }
  if (isolation === undefined || isolation.violations.length !== 0) throw new Error("provider-free boundary is unavailable or violated");
  return observed;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function loadArtifact(path: string, meter: RetainedConsumerLedger, prefix: ArtifactRead[]): unknown {
  if (realpathSync(path) !== path) throw new Error("retained artifact must use its canonical path");
  const bytes = statSync(path).size, row: ArtifactRead = { path, bytes, status: "started" };
  meter.phase = "artifact_decode";
  meter.retain(row, "artifact read prefix"); prefix.push(row);
  meter.charge(Math.ceil(bytes / 64), bytes * 4, "retained container UTF-8 and JSON decoding");
  const text = readFileSync(path, "utf8");
  if (Buffer.byteLength(text, "utf8") !== bytes) throw new Error("retained artifact changed while reading");
  const value: unknown = JSON.parse(text);
  meter.retain(value, "retained artifact container including unused fields");
  row.status = "decoded";
  return value;
}

function loadPackets(config: Configuration, meter: RetainedConsumerLedger, prefix: ArtifactRead[]): RetainedConsumerPacket[] {
  return windows.map(window => {
    const path = (file: string) => resolve(config.inputs, window.directory, file);
    const input = object(loadArtifact(path("input.json"), meter, prefix), "retained input");
    const setup = object(loadArtifact(path("setup.json"), meter, prefix), "retained setup");
    const retained = loadArtifact(path(window.response), meter, prefix);
    const fixture = object(input["fixture"], "retained original source declarations");
    const pool = object(setup["pool"], "independent setup pool");
    const bodies = fixture["sources"], records = pool["sources"];
    if (typeof fixture["original"] !== "string" || !Array.isArray(bodies) || !Array.isArray(records)) {
      throw new Error("retained original query or independent source declarations are absent");
    }
    const sources = records.map((value: unknown) => {
      meter.retain(value, "independent source record parse");
      const record = SourceRecordIdentitySchema.parse(value);
      meter.charge(bodies.length, 64, "independent source body lookup");
      const matches = bodies.map(value => object(value, "original source declaration"))
        .filter(value => value["id"] === record.source_id);
      if (matches.length !== 1 || typeof matches[0]!["body"] !== "string") throw new Error("independent source body is ambiguous or absent");
      const source = { record, body: matches[0]!["body"] };
      meter.retain(source, "independent source body projection");
      return source;
    });
    const response = window.nested ? object(retained, "retained response container")["encoded"] : retained;
    if (response === undefined) throw new Error("retained encoded response is absent");
    // This pays for reconstructed reader encoding; it is not a captured native wire packet.
    meter.retain(response, "reconstructed response JSON encoding");
    const encoded = JSON.stringify(response);
    const packet = { original_query: fixture["original"], query_semantics: fixture["semantics"], encoded_response: encoded, sources };
    meter.retain(packet, "reader packet projection");
    return packet;
  });
}

function assertDiscriminator(result: ReturnType<typeof readRetainedEvidence>) {
  expect(result).toMatchObject({ status: "completed", failure: null, native_answer_upgrade: false,
    native_continuations_executed: 0, exposure_authority: "new_offline_reader_encounter_only" });
  expect(result.packets.map(packet => packet.readouts.map(readout => readout.complete_alternatives)))
    .toEqual([[[0], [], []], [[], [], []]]);
  expect(result.packets.map(packet => packet.support?.evidence_inputs.filter(input => input.status === "supported")
    .map(({ alternative, input }) => [alternative, input]))).toEqual([[[0, 0], [0, 1]], [[1, 0], [1, 1]]]);
  expect(result.packets.flatMap(packet => packet.proof_attempts)).toHaveLength(3);
  for (const packet of result.packets) {
    expect(packet.support).toMatchObject({ answer: "unrepresented", operation: "not_executed", compatibility: "unknown", distinctness: "unknown" });
    expect(packet.proof_attempts.every(attempt => attempt.status === "verified")).toBe(true);
    expect(packet.offline_reader_exposure?.request_continuation).toBeNull();
    for (const citation of packet.citations) {
      expect(packet.native_qualifiers?.[citation.slot]?.witnesses).toContainEqual({
        conditional_computation_id: citation.conditional_computation_id, binding_id: citation.binding_id });
    }
  }
  expect(result.resource_usage.work_units).toBeLessThanOrEqual(RETAINED_CONSUMER_BUDGET.work_units);
  expect(result.resource_usage.memory_bytes).toBeLessThanOrEqual(RETAINED_CONSUMER_BUDGET.memory_bytes);
}

it.skipIf(!enabled)("reads the frozen retained responses once under a cumulative conditional-evidence allowance", () => {
  const config = configuration(), meter = new RetainedConsumerLedger(), artifacts: ArtifactRead[] = [];
  const save = (name: string, value: unknown) => writeFileSync(resolve(config.root, name), JSON.stringify(value, null, 2), { flag: "wx" });
  const premises: EvaluatorCompatibilityPremise[] = ["compatible", "unknown", "incompatible"].map(compatibility => ({
    id: "authored-common-environment", query_semantics_id: queryId,
    compatibility: compatibility as EvaluatorCompatibilityPremise["compatibility"] }));
  let readout: ReturnType<typeof readRetainedEvidence> | null = null, calls = 0, failure: string | null = null;
  save("start.json", { config, allowance: RETAINED_CONSUMER_BUDGET, premises, windows,
    input_authority: "retained original declarations plus separately captured setup source records",
    artifact_cost_scope: "whole retained containers including nondelivered plans; separate from reconstructed packet reading",
    unmetered: ["Git guards and diagnostic file capture", "physical CPU, elapsed time, I/O and peak memory"] });
  try {
    frozenCandidate(config);
    const packets = loadPackets(config, meter, artifacts);
    save("inputs.json", { packets, premises });
    calls++;
    readout = readRetainedEvidence(packets, premises, meter);
    save("readout.json", readout);
    // Persist the full observed prefix before any discriminator assertion can fail.
    assertDiscriminator(readout);
    frozenCandidate(config);
  } catch (error) {
    failure = String(error);
    throw error;
  } finally {
    save("result.json", { status: failure === null ? "passed" : "failed", failure, reader_calls: calls,
      artifact_reads: artifacts, readout, allowance: RETAINED_CONSUMER_BUDGET,
      resource_usage: { work_units: meter.spentWork, memory_bytes: meter.spentBytes }, costs: meter.costs,
      provider_boundary_violations: isolation?.violations ?? null, native_continuations_executed: 0,
      artifact_cost_scope: "whole retained containers; not actual received native-wire consumer cost",
      unmetered: ["Git guards and diagnostic file capture", "physical CPU, elapsed time, I/O and peak memory"] });
  }
}, 120_000);
