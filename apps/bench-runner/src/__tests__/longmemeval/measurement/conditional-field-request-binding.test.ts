import { describe, expect, it } from "vitest";
import { compileConditionalFieldQuery, interpretationIdentity } from "@do-soul/alaya-core";
import {
  ConditionalFieldExecutionReceiptSchema
} from "../../../runs/measurement/conditional-field-request-binding.js";
import {
  BENCH_RSS_SAMPLING_METHOD,
  sampleBenchHandleRss,
  validateBenchRecallIndex
} from "../../../harness/daemon/handle/bench-recall-response.js";
import { InformationIndexSchema } from "@do-soul/alaya-protocol";

const NOW = "2026-09-06T00:00:00.000Z";
const SNAPSHOT = `sha256:${"a".repeat(64)}`;
const BUDGET = {
  schema_version: 1 as const, work_units: 10_000, memory_bytes: 1_000_000,
  page_budget: 2, finalization_reserve: 100, min_envelope: 10
};

function compileIdentityReceipt() {
  const compile_input = {
    source: "ordinary" as const, text: "needle", snapshot_id: SNAPSHOT, budget: BUDGET,
    interpretation_clock: NOW
  };
  return {
    schema_version: 1 as const,
    workspace_id: "workspace",
    requested_budget: BUDGET,
    compile_input,
    query_id: compileConditionalFieldQuery(compile_input).query_id,
    interpretation_id: interpretationIdentity({ interpretation_clock: NOW }),
    snapshot_id: SNAPSHOT,
    interpretation_clock: NOW
  };
}

describe("conditional field execution receipt actual-cost encoding", () => {
  it("keeps compile-identity receipts valid when actual-cost fields are absent", () => {
    expect(ConditionalFieldExecutionReceiptSchema.parse(compileIdentityReceipt()).native_visits)
      .toBeUndefined();
  });

  it("accepts optional measured visits, bytes, elapsed time and live RSS", () => {
    const receipt = ConditionalFieldExecutionReceiptSchema.parse({
      ...compileIdentityReceipt(),
      native_visits: 7,
      bytes_read: 128,
      row_visits: 7,
      elapsed_ms: 1.5,
      rss_bytes: sampleBenchHandleRss().rss_bytes,
      rss_sampling_method: BENCH_RSS_SAMPLING_METHOD
    });
    expect(receipt.native_visits).toBe(7);
    expect(receipt.bytes_read).toBe(128);
    expect(receipt.row_visits).toBe(7);
    expect(receipt.elapsed_ms).toBe(1.5);
    expect(receipt.rss_bytes).toBeGreaterThan(0);
    expect(receipt.rss_sampling_method).toBe("process.memoryUsage().rss");
  });

  it("still rejects a compile-identity mismatch when actual-cost fields are present", () => {
    expect(() => ConditionalFieldExecutionReceiptSchema.parse({
      ...compileIdentityReceipt(),
      query_id: "foreign",
      native_visits: 3,
      rss_sampling_method: BENCH_RSS_SAMPLING_METHOD
    })).toThrow(/canonical request compiler/);
  });

  it("accepts an optional nested actual object from the core receipt without requiring its type", () => {
    const receipt = ConditionalFieldExecutionReceiptSchema.parse({
      ...compileIdentityReceipt(),
      native_visits: 4,
      actual: {
        native_visits: 4, native_rows: 4, native_bytes: 128, charged_retained_bytes: 64,
        phases: { observe: { exclusive_ms: 1, inclusive_ms: 2, native_visits: 4 } },
        rss: {
          method: "process.memoryUsage().rss", start_bytes: 1_000, after_projection_bytes: 1_100
        },
        extra_sibling_counter: 9
      }
    });
    expect(receipt.actual?.native_visits).toBe(4);
    expect(receipt.actual?.rss?.method).toBe("process.memoryUsage().rss");
    expect(receipt.native_visits).toBe(4);
  });

  it("rejects guessed RSS methods and unknown receipt keys", () => {
    expect(() => ConditionalFieldExecutionReceiptSchema.parse({
      ...compileIdentityReceipt(),
      rss_sampling_method: "guessed-constant"
    })).toThrow();
    expect(() => ConditionalFieldExecutionReceiptSchema.parse({
      ...compileIdentityReceipt(),
      work_units: BUDGET.work_units
    })).toThrow();
  });

  it("fills missing handle RSS from process.memoryUsage().rss without inventing visits", () => {
    const receipt = compileIdentityReceipt();
    const index = InformationIndexSchema.parse({
      schema_version: 1, query_id: receipt.query_id, snapshot_id: receipt.snapshot_id,
      result_version: "v1", interpretation_id: receipt.interpretation_id, as_of: NOW,
      entries: [],
      completeness: {
        schema_version: 1, logical_index: "open", observed_coverage: "open",
        interpretation_coverage: "open", transport: "complete", payload: "complete",
        representation: "complete"
      },
      continuation: null,
      representation: {
        schema_version: 1, policy: "construct_index_then_page_then_payload",
        page_budget: 2, identity_tie_break: "serialization"
      }
    });
    expect(() => validateBenchRecallIndex({
      execution_receipt: receipt,
      index,
      candidates: [],
      active_constraints: [],
      active_constraints_count: null,
      active_constraints_completeness: "incomplete",
      total_scanned: 0,
      coarse_filter_count: 0,
      fine_assessment_count: 0,
      degradation_reason: null,
      synthesis: { status: "absent" },
      provider_calls: 0,
      garden_enqueue: 0,
      working_projection: null
    })).not.toThrow();
    expect(receipt).not.toHaveProperty("native_visits");
  });
});
