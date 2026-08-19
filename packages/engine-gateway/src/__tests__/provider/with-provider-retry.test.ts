import { describe, expect, it, vi } from "vitest";
import { ProviderChatCompletionError } from "../../provider/chat-completion/errors.js";
import {
  isRetryableProviderHttpStatus,
  withProviderRetry
} from "../../provider/with-provider-retry.js";

describe("isRetryableProviderHttpStatus", () => {
  it("retries 429 and 5xx only", () => {
    expect(isRetryableProviderHttpStatus(429)).toBe(true);
    expect(isRetryableProviderHttpStatus(500)).toBe(true);
    expect(isRetryableProviderHttpStatus(503)).toBe(true);
    expect(isRetryableProviderHttpStatus(599)).toBe(true);
    expect(isRetryableProviderHttpStatus(400)).toBe(false);
    expect(isRetryableProviderHttpStatus(401)).toBe(false);
    expect(isRetryableProviderHttpStatus(404)).toBe(false);
    expect(isRetryableProviderHttpStatus(200)).toBe(false);
    expect(isRetryableProviderHttpStatus(600)).toBe(false);
  });
});

describe("withProviderRetry", () => {
  it("returns the first successful attempt without sleeping", async () => {
    const sleep = vi.fn(async () => undefined);
    const run = vi.fn(async () => "ok");

    await expect(withProviderRetry(run, {
      delaysMs: [100, 250],
      isRetryable: () => true,
      sleep
    })).resolves.toBe("ok");

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("uses the caller schedule and stops after the last delay", async () => {
    const sleep = vi.fn(async () => undefined);
    const run = vi.fn(async () => {
      throw Object.assign(new Error("HTTP 503"), { status: 503 });
    });

    await expect(withProviderRetry(run, {
      delaysMs: [100, 250],
      isRetryable: (error) =>
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        isRetryableProviderHttpStatus(Number((error as { status: number }).status)),
      sleep
    })).rejects.toMatchObject({ message: "HTTP 503" });

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [250]]);
  });

  it("does not retry a non-retryable error", async () => {
    const sleep = vi.fn(async () => undefined);
    const run = vi.fn(async () => {
      throw Object.assign(new Error("HTTP 401"), { status: 401 });
    });

    await expect(withProviderRetry(run, {
      delaysMs: [100, 250],
      isRetryable: () => false,
      sleep
    })).rejects.toMatchObject({ message: "HTTP 401" });

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([429, 503] as const)(
    "does not status-first retry an aborted hanging HTTP %s",
    async (status) => {
      const sleep = vi.fn(async () => undefined);
      const error = new ProviderChatCompletionError(
        "provider chat completion aborted",
        "aborted",
        status
      );
      const run = vi.fn(async () => {
        throw error;
      });

      await expect(withProviderRetry(run, {
        delaysMs: [100, 250],
        isRetryable: isStatusFirstRetryable,
        sleep
      })).rejects.toBe(error);

      expect(Object.hasOwn(error, "status")).toBe(false);
      expect(run).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    }
  );

  it("status-first retries a true HTTP 503", async () => {
    const sleep = vi.fn(async () => undefined);
    const error = new ProviderChatCompletionError(
      "provider chat completion failed: HTTP 503",
      "http_error",
      503
    );
    const run = vi.fn(async () => {
      throw error;
    });

    await expect(withProviderRetry(run, {
      delaysMs: [100, 250],
      isRetryable: isStatusFirstRetryable,
      sleep
    })).rejects.toBe(error);

    expect(Object.hasOwn(error, "status")).toBe(true);
    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[100], [250]]);
  });
});

function isStatusFirstRetryable(error: unknown): boolean {
  return typeof error === "object" &&
    error !== null &&
    "status" in error &&
    isRetryableProviderHttpStatus(Number((error as { status: number }).status));
}
