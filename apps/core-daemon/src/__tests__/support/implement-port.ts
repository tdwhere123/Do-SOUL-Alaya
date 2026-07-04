import { vi } from "vitest";

// Route/service stubs return structurally-minimal fixtures that flow straight
// into asserted HTTP JSON, so their method return types cannot be the full
// domain shapes. LooseStub keeps argument types intact (still checked) while
// erasing return types to unknown, and recurses into nested service ports.
export type LooseStub<T> = T extends (...args: infer A) => unknown
  ? (...args: A) => unknown
  : T extends object
    ? { readonly [K in keyof T]?: LooseStub<T[K]> }
    : T;

export function implementPort<T extends object>(implementation: LooseStub<T> = {} as LooseStub<T>): T {
  return new Proxy(implementation as object, {
    get(target, property, receiver) {
      if (property in target) {
        return Reflect.get(target, property, receiver);
      }
      if (property === "then") {
        return undefined;
      }
      return vi.fn(() => {
        throw new Error(`Unimplemented port method: ${String(property)}`);
      });
    }
  }) as T;
}
