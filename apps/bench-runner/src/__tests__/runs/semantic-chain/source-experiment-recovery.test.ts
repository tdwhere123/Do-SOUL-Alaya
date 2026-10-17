import { afterEach, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({ artifacts: new Map<string, unknown>(), reservation: undefined as
  { identity: string; work_units: number; memory_bytes: number } | undefined,
  admission: vi.fn(), reserve: vi.fn(), daemon: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>(), existsSync: () => true }));
vi.mock("../../../runs/semantic-chain/contract.js", () => ({
  chainIdentity: (value: unknown) => JSON.stringify(value),
  readChainArtifact: (path: string) => fixture.artifacts.get(path.split("/").at(-1)!),
  writeChainArtifact: vi.fn(), SemanticChainConfigSchema: { parse: fixture.admission },
  assertChainSnapshot: fixture.admission, withSemanticChainDaemon: fixture.daemon
}));
vi.mock("../../../runs/semantic-chain/recovery-allowance.js", () => ({ readRecoveryAction: () => fixture.reservation,
  reserveRecoveryAction: fixture.reserve, reserveRecoveryRead: fixture.admission, recoveryAllowanceIdentity: fixture.admission }));
vi.mock("../../../runs/semantic-proposal/fill.js", () => ({ readSemanticProposalResults: fixture.admission }));
import { readSourceExperiment, runSourceFeedbackExperiment, type SourceFeedbackExperimentInput } from "../../../runs/semantic-chain/source-experiment.js";

const input = { contract: "source-feedback-experiment-v1", session: { budget: { work_units: 900, memory_bytes: 800 } } } as SourceFeedbackExperimentInput;
const identity = JSON.stringify(input);
function frozen() { fixture.artifacts.set("source-experiment-input.json", input); }
function reserved() { frozen(); fixture.reservation = { identity, work_units: 900, memory_bytes: 800 }; }
function published() { reserved(); fixture.artifacts.set("source-experiment-result.json", { identity, trace: { status: "unknown", exposures: [] } }); }
afterEach(() => { fixture.artifacts.clear(); fixture.reservation = undefined; vi.clearAllMocks(); });

it("distinguishes an unstarted input from reserved unknown execution without calling live admission", async () => {
  expect(readSourceExperiment("/fixture").status).toBe("not_started");
  frozen(); expect(readSourceExperiment("/fixture").status).toBe("not_started");
  reserved();
  const state = await runSourceFeedbackExperiment(input, "/fixture");
  expect(state.status).toBe("unsettled_unknown");
  expect(fixture.admission).not.toHaveBeenCalled(); expect(fixture.reserve).not.toHaveBeenCalled(); expect(fixture.daemon).not.toHaveBeenCalled();
});

it("refuses a reusable feedback call against a frozen one-shot recovery root before execution reservation", async () => {
  fixture.artifacts.set("recovery-window.json", { contract: "source-semantic-recovery-window-v2" });
  const state = await runSourceFeedbackExperiment({ ...input, timeout_ms: 1000,
    config: { snapshot_path: "/sealed.sqlite" } } as SourceFeedbackExperimentInput, "/fixture");
  expect(state).toMatchObject({ status: "blocked", phase: "admission", execution_started: false,
    diagnostic: { message: "reusable feedback cannot bypass the recovery root's frozen execution mode" } });
  expect(fixture.reserve).not.toHaveBeenCalled(); expect(fixture.daemon).not.toHaveBeenCalled();
});

it("retains an arbitrary admission refusal as blocked rather than native execution uncertainty", async () => {
  fixture.admission.mockImplementationOnce(() => { throw Object.assign(new Error("read admission"), { code: "SQLITE_BUSY", detail: 7n }); });
  const state = await runSourceFeedbackExperiment({ ...input, config: { snapshot_path: "/sealed.sqlite" } } as SourceFeedbackExperimentInput, "/fixture");
  expect(state).toMatchObject({ status: "blocked", execution_started: false, diagnostic: { code: "SQLITE_BUSY",
    detail: { diagnostic_type: "bigint", value: "7" } } });
  expect(fixture.reserve).not.toHaveBeenCalled(); expect(fixture.daemon).not.toHaveBeenCalled();
});

it("refuses pre-cancelled execution before read admission or a whole-session reservation", async () => {
  const controller = new AbortController();
  controller.abort(Object.assign(new Error("caller stopped before admission"), { detail: 7n }));
  const state = await runSourceFeedbackExperiment(input, "/fixture", { signal: controller.signal });
  expect(state).toMatchObject({ status: "blocked", phase: "admission", execution_started: false,
    diagnostic: { message: "caller stopped before admission", detail: { diagnostic_type: "bigint", value: "7" } } });
  expect(fixture.admission).not.toHaveBeenCalled(); expect(fixture.reserve).not.toHaveBeenCalled(); expect(fixture.daemon).not.toHaveBeenCalled();
});

it("does not compete with an already claimed one-shot daemon fence", async () => {
  fixture.reservation = { identity: "retained-one-shot", work_units: 10, memory_bytes: 20 };
  const state = await runSourceFeedbackExperiment(input, "/fixture");
  expect(state.status).toBe("unsettled_unknown");
  expect(fixture.admission).not.toHaveBeenCalled(); expect(fixture.reserve).not.toHaveBeenCalled(); expect(fixture.daemon).not.toHaveBeenCalled();
});

it("keeps startup refusal distinct from an actual unknown finish without reopening the held reservation", async () => {
  reserved();
  fixture.artifacts.set("source-experiment-lifetime.json", { identity, status: "failed", phase: "startup",
    diagnostic: { code: "STARTUP_REFUSAL" } });
  const state = await runSourceFeedbackExperiment(input, "/fixture");
  expect(state).toMatchObject({ status: "unsettled_unknown", lifetime: { status: "failed", phase: "startup" } });
  expect(state.execution).toBeUndefined();
  expect(fixture.admission).not.toHaveBeenCalled(); expect(fixture.reserve).not.toHaveBeenCalled(); expect(fixture.daemon).not.toHaveBeenCalled();
  fixture.artifacts.set("source-experiment-result.json", { identity, trace: { status: "unknown", exposures: [],
    terminal_cause: { kind: "execution_error", code: "WORKER_LOST" } } });
  expect(readSourceExperiment("/fixture")).toMatchObject({ status: "result_ready",
    execution: { trace: { status: "unknown", terminal_cause: { code: "WORKER_LOST" } } } });
});

it("returns durable feedback for projection-only repair even after cleanup failed", async () => {
  published();
  fixture.artifacts.set("source-experiment-lifetime.json", { identity, status: "failed", phase: "cleanup", diagnostic: { message: "shutdown" } });
  const state = await runSourceFeedbackExperiment(input, "/fixture");
  expect(state).toMatchObject({ status: "result_ready", execution: { trace: { status: "unknown" } }, lifetime: { status: "failed" } });
  fixture.artifacts.set("source-experiment-projection.json", { identity, seed_exposure_id: null });
  expect(readSourceExperiment("/fixture").status).toBe("complete");
  expect(fixture.admission).not.toHaveBeenCalled(); expect(fixture.reserve).not.toHaveBeenCalled(); expect(fixture.daemon).not.toHaveBeenCalled();
});

it("fails closed for input, reservation, result or projection disagreement", async () => {
  published();
  await expect(runSourceFeedbackExperiment({ ...input, timeout_ms: 1 }, "/fixture")).rejects.toThrow("input changed");
  fixture.reservation!.work_units++;
  expect(() => readSourceExperiment("/fixture")).toThrow("authorities disagree");
  fixture.reservation!.work_units--;
  fixture.artifacts.set("source-experiment-result.json", { identity: "different", trace: {} });
  expect(() => readSourceExperiment("/fixture")).toThrow("authorities disagree");
  fixture.artifacts.delete("source-experiment-result.json");
  fixture.artifacts.set("source-experiment-projection.json", { identity });
  expect(() => readSourceExperiment("/fixture")).toThrow("authorities disagree");
});
