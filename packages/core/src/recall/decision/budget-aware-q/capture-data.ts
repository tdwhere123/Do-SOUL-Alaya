import { types } from "node:util";

// Reject executable shapes at ingress instead of trusting caller iteration or accessors.
export function detachInput<T>(value: T): T {
  let remaining = 8192;
  function copy(item: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 16) throw new Error("input capture bound exceeded");
    if (item === null || ["string", "number", "boolean", "undefined"].includes(typeof item)) return item;
    if (typeof item !== "object") throw new Error("unsupported input value");
    if (types.isProxy(item)) throw new Error("input proxies are not admitted");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) {
      throw new Error("unsupported input prototype");
    }
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (array) {
      const length = descriptors.length?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > remaining ||
          Object.keys(descriptors).length !== length + 1) throw new Error("sparse or oversized input array");
      for (let index = 0; index < length; index += 1) {
        if (!Object.hasOwn(descriptors, String(index))) throw new Error("sparse input array");
      }
    }
    const out: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== "string") throw new Error("unsupported input symbol");
      const descriptor = descriptors[key]!;
      if (!("value" in descriptor)) throw new Error("input accessors are not admitted");
      if (array && key === "length") continue;
      if (array && !/^(0|[1-9][0-9]*)$/u.test(key)) throw new Error("custom array properties are not admitted");
      Object.defineProperty(out, key, { value: copy(descriptor.value, depth + 1), enumerable: true });
    }
    return Object.freeze(out);
  }
  return copy(value, 0) as T;
}
