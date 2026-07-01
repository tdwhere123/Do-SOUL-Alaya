import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  bindStandardConfigPatchResponse,
  bindStandardResponse,
  ConfigPatchAckResponseSchema,
  createConfigRouteResponseSchema,
  createFlatOrEnvelopedReadSchema,
  createStandardConfigPatchResponse,
  createStandardResponse,
  isZodValidationError,
  StandardConfigPatchResponseSchema,
  StandardResponseSchema,
  unwrapStandardResponseData
} from "../../shared/standard-response.js";

const SampleSchema = z.object({ enabled: z.boolean() }).readonly();

describe("StandardResponseSchema", () => {
  it("binds success envelopes for producers", () => {
    expect(bindStandardResponse(SampleSchema, { enabled: true })).toEqual({
      success: true,
      data: { enabled: true }
    });
  });

  it("rejects invalid producer payloads", () => {
    expect(() => bindStandardResponse(SampleSchema, { enabled: "yes" })).toThrow(z.ZodError);
  });
});

describe("StandardConfigPatchResponseSchema", () => {
  it("binds patch envelopes with restart hints", () => {
    expect(
      bindStandardConfigPatchResponse(SampleSchema, { enabled: false }, { requiresDaemonRestart: true })
    ).toEqual({
      success: true,
      data: { enabled: false },
      requires_daemon_restart: true
    });
  });

  it("accepts patch ack envelopes without data", () => {
    expect(ConfigPatchAckResponseSchema.parse({ success: true, requires_daemon_restart: true })).toEqual({
      success: true,
      requires_daemon_restart: true
    });
  });
});

describe("unwrapStandardResponseData", () => {
  it("unwraps enveloped reads and preserves flat payloads", () => {
    expect(unwrapStandardResponseData({ success: true, data: { enabled: true } })).toEqual({
      enabled: true
    });
    expect(unwrapStandardResponseData({ enabled: true })).toEqual({ enabled: true });
  });

  it("round-trips through createStandardResponse helpers", () => {
    const envelope = createStandardResponse({ enabled: true });
    expect(unwrapStandardResponseData(envelope)).toEqual({ enabled: true });
    const patch = createStandardConfigPatchResponse({ enabled: true }, { requiresDaemonRestart: true });
    expect(patch.requires_daemon_restart).toBe(true);
  });
});

describe("createFlatOrEnvelopedReadSchema", () => {
  it("accepts enveloped and flat config reads", () => {
    const schema = createFlatOrEnvelopedReadSchema(SampleSchema);
    expect(schema.parse({ success: true, data: { enabled: true } })).toEqual({ enabled: true });
    expect(schema.parse({ enabled: false })).toEqual({ enabled: false });
  });
});

describe("createConfigRouteResponseSchema", () => {
  it("accepts enveloped, flat, and patch-ack shapes", () => {
    const schema = createConfigRouteResponseSchema(SampleSchema, { allowPatchAck: true });
    expect(schema.parse({ success: true, data: { enabled: true } })).toEqual({
      success: true,
      data: { enabled: true }
    });
    expect(schema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(schema.parse({ success: true, requires_daemon_restart: true })).toEqual({
      success: true,
      requires_daemon_restart: true
    });
  });
});

describe("isZodValidationError", () => {
  it("detects zod validation failures", () => {
    try {
      SampleSchema.parse({ enabled: "nope" });
    } catch (error) {
      expect(isZodValidationError(error)).toBe(true);
    }
    expect(isZodValidationError(new Error("other"))).toBe(false);
  });
});
