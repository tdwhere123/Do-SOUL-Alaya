import { describe, expect, it, vi } from "vitest";
import {
  wrapRecallFaultWarn,
  type RecallFailureHealthInboxPort
} from "../../recall/recall-failure-health-inbox.js";

describe("wrapRecallFaultWarn", () => {
  it("records an inbox entry for an unexpected error name and still calls the base warn", async () => {
    const baseWarn = vi.fn();
    const recordRecallFailure = vi.fn(async () => undefined);
    const inbox: RecallFailureHealthInboxPort = { recordRecallFailure };
    const warn = wrapRecallFaultWarn(baseWarn, inbox, "workspace-1", () => "2026-06-23T00:00:00.000Z");

    warn("recall lane crashed", { operation: "fts_scan", errorName: "TypeError" });
    await Promise.resolve();

    expect(baseWarn).toHaveBeenCalledWith("recall lane crashed", expect.any(Object));
    expect(recordRecallFailure).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      operation: "fts_scan",
      observedAt: "2026-06-23T00:00:00.000Z"
    });
  });

  it("does not record for expected degradation error names", async () => {
    const recordRecallFailure = vi.fn(async () => undefined);
    const warn = wrapRecallFaultWarn(vi.fn(), { recordRecallFailure }, "workspace-1", () => "now");

    warn("graceful degradation", { operation: "embedding", errorName: "AbortError" });
    await Promise.resolve();

    expect(recordRecallFailure).not.toHaveBeenCalled();
  });

  it("surfaces a warning but never throws when the health-inbox write rejects", async () => {
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    try {
      const recordRecallFailure = vi.fn(async () => {
        throw new Error("inbox offline");
      });
      const warn = wrapRecallFaultWarn(vi.fn(), { recordRecallFailure }, "workspace-1", () => "now");

      expect(() => warn("recall lane crashed", { operation: "fts_scan", errorName: "RangeError" })).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();

      expect(recordRecallFailure).toHaveBeenCalledTimes(1);
      expect(emitWarning).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ code: "ALAYA_RECALL_FAILURE_INBOX_WRITE_FAILED" })
      );
    } finally {
      emitWarning.mockRestore();
    }
  });
});
