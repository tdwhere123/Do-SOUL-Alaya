import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom does not implement ResizeObserver. Components that rely on it must still
// mount in tests; the Graph page additionally performs an initial sync render
// path that does not depend on the observer firing.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
