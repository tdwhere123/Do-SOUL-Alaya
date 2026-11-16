const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import(
    "../../../../../../scripts/test-support/provider-free/provider-free-boundary.js"
  );
  return installProviderFreeBoundary();
});
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  type Continuation
} from "@do-soul/alaya-protocol";
import { prepareBenchRecallRequest } from "../../../harness/daemon/handle/bench-recall-request.js";
import type { BenchRecallOptions } from "../../../harness/daemon/daemon-types.js";
import type { BenchRecallWeightOverrides } from "../../../harness/recall/recall-weight-overrides.js";

afterAll(() => {
  isolation.restore();
  expect(isolation.violations).toEqual([]);
});
afterEach(() => {
  vi.useRealTimers();
});

const CLOCK_A = "2026-09-06T00:00:00.000Z";
const CLOCK_B = "2026-09-05T00:00:00.000Z";
const CLOCK_C = "2026-09-04T00:00:00.000Z";
const SNAPSHOT = `sha256:${"b".repeat(64)}`;
const OPTIONAL_INVOKE_KEYS = [
  "referenceTime",
  "querySemanticFactorFormationCapture",
  "querySemanticFactorCompletenessReceipt",
  "snapshotDigest",
  "continuation",
  "cancelled",
  "since",
  "until",
  "timeFilter",
  "enumeration_policy",
  "cap_contracts",
  "result_kind_view"
] as const;

const budget: NonNullable<BenchRecallOptions["budget"]> = {
  schema_version: 1, work_units: 1000, memory_bytes: 65536,
  page_budget: 1, finalization_reserve: 100, min_envelope: 10
};

function requestInput(env: Readonly<Record<string, string | undefined>> = {}) {
  return {
    activeContext: { workspaceId: "workspace-1", runId: "run-1" },
    effectiveEnv: env
  };
}

function continuation(clock = CLOCK_C, snapshot = SNAPSHOT): Continuation {
  return {
    schema_version: 1, continuation_id: "next", query_id: "query", snapshot_id: snapshot,
    result_version: "v1", cursor: "next", expires_at: "2099-01-01T00:00:00.000Z",
    interpretation_id: "interpretation", interpretation_clock: clock
  };
}

describe("prepareBenchRecallRequest forwarding", () => {
  it("omits undefined optional own-properties and keeps protocol support flags", () => {
    const invoke = prepareBenchRecallRequest(requestInput(), "needle");
    for (const key of OPTIONAL_INVOKE_KEYS) {
      expect(Object.hasOwn(invoke, key)).toBe(false);
    }
    expect(Object.hasOwn(invoke, "defer_delivery")).toBe(false);
    expect(Object.hasOwn(invoke, "recallService")).toBe(false);
    expect(Object.hasOwn(invoke, "supports_product_updates")).toBe(false);
    expect(invoke.sideEffectMode).toBe("benchmark");
    expect(invoke.strategy).toBe("chat");
    expect(invoke.protocol_version).toBe(1);
    expect(invoke.supports_source_evidence).toBe(true);
    expect(invoke.supported_result_kinds).toEqual(["memory_entry", "source_evidence"]);
    expect(Object.hasOwn(invoke, "activeConstraintsCap")).toBe(true);
    expect(invoke.activeConstraintsCap).toBeNull();
    expect(invoke.queryText).toBe("needle");
    expect(invoke.workspaceId).toBe("workspace-1");
    expect(invoke.runId).toBe("run-1");
    expect(invoke.diagnosticCapture).toBe("answer_features");
    expect(invoke.taskSurface.display_name).toBe("needle");
    expect(invoke.taskSurface.object_kind).toBe(ControlPlaneObjectKind.TASK_OBJECT_SURFACE);
    expect(invoke.taskSurface.retention_policy).toBe(RetentionPolicy.SESSION_ONLY);
    expect(invoke.taskSurface.surface_kind).toBe("mcp_memory_tool");
    expect(invoke.taskSurface.task_surface_ref).toBeNull();
    expect(invoke.policyOverride.task_surface_ref).toBe(invoke.taskSurface.runtime_id);
  });

  it("forwards supplied optional fields without replacing caller budget identity", () => {
    const token = continuation();
    const timeFilter = { field: "last_used_at" as const };
    const opts: BenchRecallOptions = {
      referenceTime: CLOCK_B, snapshotDigest: SNAPSHOT, continuation: token, cancelled: true,
      since: "2020-01-01T00:00:00.000Z", until: CLOCK_A, timeFilter,
      enumeration_policy: "native_query", result_kind_view: "mixed", budget,
      interpretationClock: CLOCK_A
    };
    const invoke = prepareBenchRecallRequest(requestInput(), "needle", opts);
    expect(invoke.budget).toEqual(budget);
    expect(invoke.referenceTime).toBe(CLOCK_B);
    expect(invoke.snapshotDigest).toBe(SNAPSHOT);
    expect(invoke.continuation).toBe(token);
    expect(invoke.cancelled).toBe(true);
    expect(invoke.since).toBe("2020-01-01T00:00:00.000Z");
    expect(invoke.until).toBe(CLOCK_A);
    expect(invoke.timeFilter).toBe(timeFilter);
    expect(invoke.enumeration_policy).toBe("native_query");
    expect(invoke.result_kind_view).toBe("mixed");
  });

  it("forwards continuation: null as an own property rather than omitting it", () => {
    const invoke = prepareBenchRecallRequest(requestInput(), "needle", { continuation: null });
    expect(Object.hasOwn(invoke, "continuation")).toBe(true);
    expect(invoke.continuation).toBeNull();
  });

  it.each([
    {
      name: "interpretationClock over referenceTime and continuation",
      opts: { interpretationClock: CLOCK_A, referenceTime: CLOCK_B, continuation: continuation(CLOCK_C) },
      expected: CLOCK_A
    },
    {
      name: "referenceTime over continuation when interpretationClock is omitted",
      opts: { referenceTime: CLOCK_B, continuation: continuation(CLOCK_C) },
      expected: CLOCK_B
    },
    {
      name: "continuation clock when explicit clocks are omitted",
      opts: { continuation: continuation(CLOCK_C) },
      expected: CLOCK_C
    }
  ])("uses $name", ({ opts, expected }) => {
    const invoke = prepareBenchRecallRequest(requestInput(), "needle", opts);
    expect(invoke.interpretationClock).toBe(expected);
  });

  it("falls back to the current clock only after explicit and continuation clocks are absent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(CLOCK_A));
    const invoke = prepareBenchRecallRequest(requestInput(), "needle");
    expect(invoke.interpretationClock).toBe(CLOCK_A);
  });

  it("selects packet_trace only for the exact env flag and not other truthy values", () => {
    expect(prepareBenchRecallRequest(requestInput({ ALAYA_BENCH_RECALL_PACKET_TRACE: "1" }), "needle")
      .diagnosticCapture).toBe("packet_trace");
    expect(prepareBenchRecallRequest(requestInput({ ALAYA_BENCH_RECALL_PACKET_TRACE: "true" }), "needle")
      .diagnosticCapture).toBe("answer_features");
  });

  it("keeps distinct task surface ids across preparations of the same query", () => {
    const first = prepareBenchRecallRequest(requestInput(), "needle");
    const second = prepareBenchRecallRequest(requestInput(), "needle");
    expect(first.taskSurface.runtime_id).not.toBe(second.taskSurface.runtime_id);
  });

  it("does not treat omitted maxResults/budget as a conflict and still refuses a real conflict", () => {
    expect(() => prepareBenchRecallRequest(requestInput(), "needle", { maxResults: 2 })).not.toThrow();
    expect(() => prepareBenchRecallRequest(requestInput(), "needle", { maxResults: 2, budget }))
      .toThrow(/maxResults conflicts/);
  });

  it("does not apply retired weight overrides", () => {
    const overrides = { source: "cli", summary: {} } as BenchRecallWeightOverrides;
    expect(() => prepareBenchRecallRequest({ ...requestInput(), recallWeightOverrides: overrides }, "needle"))
      .toThrow(/retired/);
  });
});
