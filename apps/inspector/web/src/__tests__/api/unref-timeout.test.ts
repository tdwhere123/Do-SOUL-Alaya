import { describe, expect, it, vi } from "vitest";
import { unrefTimeout } from "../../api/unref-timeout";

describe("unrefTimeout", () => {
  it("is a no-op for numeric DOM timers", () => {
    expect(() => unrefTimeout(1 as unknown as ReturnType<typeof setTimeout>)).not.toThrow();
  });

  it("calls unref when the handle is a Node timeout object", () => {
    const unref = vi.fn();
    unrefTimeout({ unref } as unknown as ReturnType<typeof setTimeout>);
    expect(unref).toHaveBeenCalledOnce();
  });

  it("is a no-op for objects without unref", () => {
    expect(() => unrefTimeout({} as unknown as ReturnType<typeof setTimeout>)).not.toThrow();
  });
});
