import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useApiQuery } from "../../hooks/useApiQuery";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("useApiQuery", () => {
  it("clears initial loading when a background refresh replaces an in-flight request", async () => {
    const initial = deferred<string>();
    const refresh = deferred<string>();
    let callCount = 0;
    const fetcher = vi.fn(() => {
      callCount += 1;
      return callCount === 1 ? initial.promise : refresh.promise;
    });

    const { result } = renderHook(() => useApiQuery(fetcher, []));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(result.current.loading).toBe(true);

    let refreshPromise!: Promise<string | null>;
    await act(async () => {
      refreshPromise = result.current.refetch("background");
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      refresh.resolve("ready");
      await refreshPromise;
    });

    expect(result.current.data).toBe("ready");
    expect(result.current.loading).toBe(false);
  });

  it("ignores a fetcher result that resolves after the query is disabled", async () => {
    const pending = deferred<string>();
    const fetcher = vi.fn(() => pending.promise);
    const { result, rerender } = renderHook(
      ({ enabled }: { readonly enabled: boolean }) => useApiQuery(fetcher, [], { enabled }),
      { initialProps: { enabled: true } }
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });

    await act(async () => {
      pending.resolve("stale");
      await pending.promise;
    });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
  });
});
