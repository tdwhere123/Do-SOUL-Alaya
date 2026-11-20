import { types } from "node:util";

function prototypeGetter(ctor: unknown, prop: string): ((this: unknown) => unknown) | undefined {
  if (typeof ctor !== "function" || ctor.prototype === null || typeof ctor.prototype !== "object") return undefined;
  const desc = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
  return typeof desc?.get === "function" ? desc.get : undefined;
}

const g = globalThis as Record<string, unknown>;
const wasmGlobal = g.WebAssembly as Record<string, unknown> | undefined;
const intlGlobal = g.Intl as Record<string, unknown> | undefined;

const NATIVE_SLOT_GETTERS: ReadonlyArray<(this: unknown) => unknown> = [
  prototypeGetter(g.DisposableStack, "disposed"),
  prototypeGetter(g.AsyncDisposableStack, "disposed"),
  prototypeGetter(wasmGlobal?.Memory, "buffer"),
  prototypeGetter(wasmGlobal?.Table, "length"),
  prototypeGetter(wasmGlobal?.Global, "value"),
  prototypeGetter(wasmGlobal?.Instance, "exports"),
  prototypeGetter(intlGlobal?.Locale, "baseName")
].filter((fn): fn is (this: unknown) => unknown => fn !== undefined);

const cryptoSingleton = g.crypto;
const subtleCryptoSingleton = typeof g.crypto === "object" && g.crypto !== null
  ? (g.crypto as { subtle?: unknown }).subtle : undefined;
const performanceSingleton = g.performance;
const navigatorSingleton = g.navigator;
const finRegProbeToken = {};
const wasmModuleCustomSections = (wasmGlobal?.Module as {
  customSections?(mod: object, name: string): unknown[];
} | undefined)?.customSections;

function hasNativeInternalBrand(value: object): boolean {
  if (
    (cryptoSingleton !== undefined && value === cryptoSingleton) ||
    (subtleCryptoSingleton !== undefined && value === subtleCryptoSingleton) ||
    (performanceSingleton !== undefined && value === performanceSingleton) ||
    (navigatorSingleton !== undefined && value === navigatorSingleton)
  ) {
    return true;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (let i = 0; i < NATIVE_SLOT_GETTERS.length; i += 1) {
    try {
      NATIVE_SLOT_GETTERS[i]!.call(value);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Side-effect-free fast guard rejecting Proxies, boxed primitives, native exotic
 * objects, and zero-property instances failing structured-clone checks without opening
 * an in-process inspector session.
 */
export function hasFastExoticInternalSlots(value: object, isZeroPropCloneable: (obj: object) => boolean): boolean {
  if (
    types.isProxy(value) || types.isBoxedPrimitive(value) || types.isDate(value) || types.isRegExp(value) ||
    types.isNativeError(value) || types.isArgumentsObject(value) || types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) || types.isMap(value) || types.isSet(value) || types.isWeakMap(value) ||
    types.isWeakSet(value) || types.isPromise(value) || types.isGeneratorObject(value) ||
    types.isMapIterator(value) || types.isSetIterator(value) || types.isModuleNamespaceObject(value) ||
    types.isExternal(value) || types.isKeyObject(value) || types.isCryptoKey(value)
  ) {
    return true;
  }
  if (hasNativeInternalBrand(value)) return true;
  try { WeakRef.prototype.deref.call(value); return true; } catch {}
  try { FinalizationRegistry.prototype.unregister.call(value, finRegProbeToken); return true; } catch {}
  if (wasmModuleCustomSections !== undefined) {
    try { wasmModuleCustomSections(value, ""); return true; } catch {}
  }
  if (!Array.isArray(value) && Object.getOwnPropertyNames(value).length === 0 && Object.getOwnPropertySymbols(value).length === 0) {
    return !isZeroPropCloneable(value);
  }
  return false;
}
