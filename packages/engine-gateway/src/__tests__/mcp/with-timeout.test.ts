import { afterEach, describe, expect, it, vi } from "vitest";
import { withTimeout } from "../../mcp/with-timeout.js";

const handlerTimeoutError = {
  error_code: "handler_timeout",
  message: "MCP tool execution timed out.",
  error_type: "TimeoutError"
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withTimeout", () => {
  it("resolves with the operation result when it finishes within the bound", async () => {
    await expect(withTimeout(async () => "ok", 1000)).resolves.toBe("ok");
  });

  it("rejects with the handler_timeout error when the operation hangs past the bound", async () => {
    await expect(withTimeout(() => new Promise<never>(() => {}), 10)).rejects.toEqual(
      handlerTimeoutError
    );
  });

  it("signals the AbortSignal passed to the operation on timeout", async () => {
    let observed: AbortSignal | undefined;
    const work = (signal: AbortSignal): Promise<never> => {
      observed = signal;
      return new Promise<never>(() => {});
    };

    await expect(withTimeout(work, 10)).rejects.toEqual(handlerTimeoutError);

    expect(observed?.aborted).toBe(true);
    expect(observed?.reason).toEqual(handlerTimeoutError);
  });

  it("does not raise an unhandledRejection when the abandoned operation rejects after timeout", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate: (reason: unknown) => void = () => {};
      const work = (): Promise<never> =>
        new Promise<never>((_resolve, reject) => {
          rejectLate = reject;
        });

      await expect(withTimeout(work, 10)).rejects.toEqual(handlerTimeoutError);

      // The handler loses its race but still rejects afterwards.
      rejectLate(new Error("late handler failure"));
      // Flush microtasks + a macrotask so a stray rejection would have surfaced.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("accepts an eager promise and still suppresses its late rejection after timeout", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let rejectLate: (reason: unknown) => void = () => {};
      const eager = new Promise<never>((_resolve, reject) => {
        rejectLate = reject;
      });

      await expect(withTimeout(eager, 10)).rejects.toEqual(handlerTimeoutError);

      rejectLate(new Error("late eager failure"));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});
