/**
 * FROZEN RED TESTS — L0-B runs.update_engine_binding
 *
 * Locks the protocol schema contract for:
 *   - RunUpdateEngineBindingInputSchema (zod input validation)
 *   - RUN_ENGINE_BINDING_UPDATED event type + payload schema
 *
 * These imports WILL fail until the implementation ships — that is the
 * intended RED state.
 */

import { describe, expect, it } from "vitest";
// RED: these named exports do not exist yet in packages/protocol/src/run.ts
// or a sibling file. The tests will fail at import-resolution / first expect.
import {
  RunUpdateEngineBindingInputSchema,
  RunEngineBindingUpdatedPayloadSchema,
  // RUN_ENGINE_BINDING_UPDATED must be a member of Phase0EventType or a new
  // event-type enum introduced alongside the feature.
} from "@do-soul/alaya-protocol";

describe("RunUpdateEngineBindingInputSchema", () => {
  it("accepts a valid input with run_id and engine_binding_id", () => {
    const result = RunUpdateEngineBindingInputSchema.safeParse({
      run_id: "run_abc123",
      engine_binding_id: "binding_xyz456"
    });
    expect(result.success).toBe(true);
  });

  it("rejects when run_id is an empty string", () => {
    const result = RunUpdateEngineBindingInputSchema.safeParse({
      run_id: "",
      engine_binding_id: "binding_xyz456"
    });
    expect(result.success).toBe(false);
  });

  it("rejects when engine_binding_id is an empty string", () => {
    const result = RunUpdateEngineBindingInputSchema.safeParse({
      run_id: "run_abc123",
      engine_binding_id: ""
    });
    expect(result.success).toBe(false);
  });

  it("rejects when run_id is missing", () => {
    const result = RunUpdateEngineBindingInputSchema.safeParse({
      engine_binding_id: "binding_xyz456"
    });
    expect(result.success).toBe(false);
  });

  it("rejects when engine_binding_id is missing", () => {
    const result = RunUpdateEngineBindingInputSchema.safeParse({
      run_id: "run_abc123"
    });
    expect(result.success).toBe(false);
  });
});

describe("RunEngineBindingUpdatedPayloadSchema", () => {
  it("accepts a valid payload with all three fields", () => {
    const result = RunEngineBindingUpdatedPayloadSchema.safeParse({
      run_id: "run_abc123",
      engine_binding_id: "binding_new",
      previous_engine_binding_id: "binding_old"
    });
    expect(result.success).toBe(true);
  });

  it("accepts previous_engine_binding_id as null (first-time binding set)", () => {
    // Failure Mode #12 context: when a run has never had a binding, the
    // previous value is null. The schema must permit this.
    const result = RunEngineBindingUpdatedPayloadSchema.safeParse({
      run_id: "run_abc123",
      engine_binding_id: "binding_new",
      previous_engine_binding_id: null
    });
    expect(result.success).toBe(true);
  });

  it("rejects when run_id is empty", () => {
    const result = RunEngineBindingUpdatedPayloadSchema.safeParse({
      run_id: "",
      engine_binding_id: "binding_new",
      previous_engine_binding_id: null
    });
    expect(result.success).toBe(false);
  });

  it("rejects when engine_binding_id is empty", () => {
    const result = RunEngineBindingUpdatedPayloadSchema.safeParse({
      run_id: "run_abc123",
      engine_binding_id: "",
      previous_engine_binding_id: null
    });
    expect(result.success).toBe(false);
  });
});
