import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SignalState,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createAlayaCliBridge,
  type AlayaCliDaemonRuntime
} from "../../cli/bridge.js";
import { createSourceGroundingDefersCommand } from "../../cli/source-grounding-defers/command.js";

const CLAIM_TOKEN_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const RAW_CLAIM_TOKEN = "claim-capability-secret";

function createHarness() {
  const stdout = createTextSink();
  const stderr = createTextSink();
  const service = {
    getSourceGroundingDeferStats: vi.fn(() => ({
      queue_depth: 3,
      queue_cap: 2,
      queue_cap_per_workspace: 2,
      queue_hard_limit_per_workspace: 3,
      queue_scope: "workspace" as const,
      claimable_depth: 2,
      capacity_blocked_depth: 1,
      capacity_state: "saturated" as const,
      deferred_by_reason: {
        source_assertion_incomplete: 3,
        secret_reason: 41
      },
      private_stats: "stats-capability-secret"
    })),
    listSourceGroundingDefers: vi.fn(() => [{
      signal_id: "signal-1",
      workspace_id: "workspace-1",
      run_id: "run-1",
      defer_reason: "source_assertion_incomplete" as const,
      enqueued_at: "2026-07-15T00:00:00.000Z",
      claim_token_fingerprint: CLAIM_TOKEN_FINGERPRINT,
      claim_token: RAW_CLAIM_TOKEN,
      claim_expires_at: "2026-07-15T01:00:00.000Z",
      admission_state: "ready" as const,
      private_entry: "entry-capability-secret"
    }]),
    redriveSourceGroundingDefer: vi.fn(async () => ({
      signal: createSignal(SignalState.MATERIALIZED),
      triage_result: "accepted" as const,
      materialization: {
        signal_id: "signal-1",
        target_kind: "memory_and_claim" as const,
        routing_reason: "object_kind routed",
        created_objects: [],
        success: true as const
      }
    })),
    reconcileStaleSourceGroundingRedrive: vi.fn(async () =>
      createSignal(SignalState.DEFERRED))
  };
  const bridge = createAlayaCliBridge(
    { startupSteps: [{ step: "http-app" }] } as unknown as AlayaCliDaemonRuntime,
    { stdout: stdout.stream, stderr: stderr.stream, stdin: new PassThrough(), isTTY: false }
  );
  bridge.registerSubcommand(createSourceGroundingDefersCommand({ signalService: service }));
  return { bridge, service, stdout, stderr };
}

describe("source-grounding-defers CLI", () => {
  it("lists workspace-scoped obligations with explicit cap semantics", async () => {
    const { bridge, service, stdout } = createHarness();
    await bridge.dispatch([
      "source-grounding-defers",
      "list",
      "--workspace",
      "workspace-1",
      "--limit",
      "25"
    ]);

    expect(service.listSourceGroundingDefers).toHaveBeenCalledWith("workspace-1", 25);
    expect(stdout.readText()).toContain(
      "queue_total=3 cap_per_workspace=2 hard_limit_per_workspace=3 blocked=1 capacity=saturated returned=1"
    );
    expect(stdout.readText()).toContain(`claim_fingerprint=${CLAIM_TOKEN_FINGERPRINT}`);
    expect(stdout.readText()).not.toContain(RAW_CLAIM_TOKEN);
    expect(stdout.readText()).not.toContain("entry-capability-secret");
    expect(stdout.readText()).not.toContain("stats-capability-secret");
    expect(stdout.readText()).not.toContain("secret_reason");
  });

  it("returns only the stable claim fingerprint in JSON", async () => {
    const { bridge, stdout } = createHarness();
    await bridge.dispatch([
      "source-grounding-defers",
      "list",
      "--workspace",
      "workspace-1",
      "--json"
    ]);

    const report = JSON.parse(stdout.readText()) as {
      entries: readonly Record<string, unknown>[];
      stats: Record<string, unknown> & { deferred_by_reason: Record<string, unknown> };
    };
    expect(report.entries[0]).toMatchObject({
      claim_token_fingerprint: CLAIM_TOKEN_FINGERPRINT
    });
    expect(report.entries[0]).not.toHaveProperty("claim_token");
    expect(report.entries[0]).not.toHaveProperty("private_entry");
    expect(report.stats).not.toHaveProperty("private_stats");
    expect(report.stats.deferred_by_reason).toEqual({ source_assertion_incomplete: 3 });
    expect(stdout.readText()).not.toContain(RAW_CLAIM_TOKEN);
    expect(stdout.readText()).not.toContain("capability-secret");
    expect(stdout.readText()).not.toContain("secret_reason");
  });

  it.each([
    "raw-claim-capability-secret",
    `sha256:${"A".repeat(64)}`,
    "sha256:1234"
  ])("fails closed without echoing invalid claim fingerprint %s", async (invalidFingerprint) => {
    const { bridge, service, stdout, stderr } = createHarness();
    const [entry] = service.listSourceGroundingDefers();
    service.listSourceGroundingDefers.mockReturnValueOnce([{
      ...entry!,
      claim_token_fingerprint: invalidFingerprint
    }]);

    const result = await bridge.dispatch([
      "source-grounding-defers",
      "list",
      "--workspace",
      "workspace-1",
      "--json"
    ]);

    expect(result.exitCode).toBe(70);
    expect(stdout.readText()).toBe("");
    expect(stderr.readText()).toMatch(/^CLI failure \[category=subcommand error_id=/u);
    expect(stderr.readText()).not.toContain(invalidFingerprint);
  });

  it("fails closed without echoing an invalid stats scalar", async () => {
    const { bridge, service, stdout, stderr } = createHarness();
    service.getSourceGroundingDeferStats.mockReturnValueOnce({
      ...service.getSourceGroundingDeferStats(),
      queue_depth: "stats-scalar-secret"
    } as never);

    const result = await bridge.dispatch([
      "source-grounding-defers",
      "list",
      "--workspace",
      "workspace-1",
      "--json"
    ]);

    expect(result.exitCode).toBe(70);
    expect(stdout.readText()).toBe("");
    expect(stderr.readText()).not.toContain("stats-scalar-secret");
  });

  it("redrives from a bounded payload file without putting content in argv or output", async () => {
    const { bridge, service, stdout } = createHarness();
    const directory = await mkdtemp(path.join(os.tmpdir(), "alaya-redrive-"));
    const patchPath = path.join(directory, "patch.json");
    try {
      await writeFile(
        patchPath,
        JSON.stringify({ full_turn_content: "private correction" }),
        "utf8"
      );
      await bridge.dispatch([
        "source-grounding-defers",
        "redrive",
        "--workspace",
        "workspace-1",
        "--signal",
        "signal-1",
        "--raw-payload-file",
        patchPath,
        "--json"
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }

    expect(service.redriveSourceGroundingDefer).toHaveBeenCalledWith(
      "workspace-1",
      "signal-1",
      { raw_payload: { full_turn_content: "private correction" } }
    );
    expect(stdout.readText()).not.toContain("private correction");
    expect(JSON.parse(stdout.readText())).toMatchObject({
      action: "redrive",
      workspace_id: "workspace-1",
      signal_state: SignalState.MATERIALIZED
    });
  });

  it("requires and forwards the expected stale-claim fingerprint and operator reason", async () => {
    const { bridge, service, stdout } = createHarness();
    const result = await bridge.dispatch([
      "source-grounding-defers",
      "reconcile",
      "--workspace",
      "workspace-1",
      "--signal",
      "signal-1",
      "--expected-claim-fingerprint",
      CLAIM_TOKEN_FINGERPRINT,
      "--expected-claim-expires-at",
      "2000-01-01T00:00:00.000Z",
      "--reason",
      "verified no durable side effect"
    ]);

    expect(result.exitCode).toBe(0);
    expect(service.reconcileStaleSourceGroundingRedrive).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      signalId: "signal-1",
      claimTokenFingerprint: CLAIM_TOKEN_FINGERPRINT,
      expectedClaimExpiresAt: "2000-01-01T00:00:00.000Z",
      reason: "verified no durable side effect"
    });
    expect(stdout.readText()).not.toContain(RAW_CLAIM_TOKEN);
    expect(stdout.readText()).not.toContain("verified no durable side effect");
  });
});

function createTextSink() {
  const stream = new PassThrough();
  let content = "";
  stream.on("data", (chunk) => {
    content += chunk.toString("utf8");
  });
  return { stream, readText: () => content };
}

function createSignal(signalState: CandidateMemorySignal["signal_state"]): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: signalState,
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: [],
    confidence: 0.9,
    evidence_refs: ["evidence-1"],
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
    raw_payload: {},
    created_at: "2026-07-15T00:00:00.000Z"
  };
}
