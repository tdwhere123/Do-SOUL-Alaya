import { types } from "node:util";
import { canonicalJson } from "@do-soul/alaya-protocol";
import { hasFastExoticInternalSlots } from "./exotic-object-guard.js";

type EnvelopeEntry = { key: string; value: unknown };

function extractSingleCopyEnvelopeShape(
  envelope: Record<string, unknown>
): { entries: EnvelopeEntry[]; text: string; structuredValue: unknown } | null {
  const entries: EnvelopeEntry[] = [];
  let contentDesc: PropertyDescriptor | undefined;
  let structuredDesc: PropertyDescriptor | undefined;
  const envelopeKeys = Object.getOwnPropertyNames(envelope);
  for (let i = 0; i < envelopeKeys.length; i += 1) {
    const key = envelopeKeys[i]!;
    const desc = Object.getOwnPropertyDescriptor(envelope, key);
    if (desc === undefined || desc.enumerable !== true || !Object.hasOwn(desc, "value")) {
      return null;
    }
    if (key === "content") contentDesc = desc;
    else if (key === "structuredContent") structuredDesc = desc;
    pushOwn(entries, { key, value: desc.value });
  }
  if (contentDesc === undefined || structuredDesc === undefined || structuredDesc.value === undefined) {
    return null;
  }
  const content = contentDesc.value;
  if (
    types.isProxy(content) ||
    !Array.isArray(content) ||
    Object.getPrototypeOf(content) !== Array.prototype ||
    content.length !== 1 ||
    Object.getOwnPropertyNames(content).length !== 2
  ) {
    return null;
  }
  const elDesc = Object.getOwnPropertyDescriptor(content, "0");
  if (elDesc === undefined || elDesc.enumerable !== true || !Object.hasOwn(elDesc, "value")) {
    return null;
  }
  const block = elDesc.value;
  if (!isPlainNonProxyObject(block) || Object.getOwnPropertyNames(block).length !== 2) return null;
  const typeDesc = Object.getOwnPropertyDescriptor(block, "type");
  const textDesc = Object.getOwnPropertyDescriptor(block, "text");
  if (
    typeDesc === undefined || typeDesc.enumerable !== true || !Object.hasOwn(typeDesc, "value") ||
    textDesc === undefined || textDesc.enumerable !== true || !Object.hasOwn(textDesc, "value")
  ) {
    return null;
  }
  if (typeDesc.value !== "text" || typeof textDesc.value !== "string") return null;
  return { entries, text: textDesc.value, structuredValue: structuredDesc.value };
}

/**
 * Projects a model-facing MCP JSON `CallToolResult` envelope to a single copy when `content` is
 * a single text block encoding the exact JSON value of `structuredContent`, leaving non-duplicate,
 * multi-block, or unparseable envelopes intact without mutating the audit envelope.
 */
export function projectSingleCopyToolResult(envelope: unknown): unknown {
  if (Object.getPrototypeOf(Array.prototype) !== Object.prototype) return envelope;
  if (!isPlainNonProxyObject(envelope)) return envelope;
  const shape = extractSingleCopyEnvelopeShape(envelope);
  if (shape === null || !isStrictJsonData(envelope)) return envelope;
  if (!matchesStructuredContentText(shape.text, shape.structuredValue)) return envelope;
  const projected: Record<string, unknown> = Object.getPrototypeOf(envelope) === null ? Object.create(null) : {};
  for (let i = 0; i < shape.entries.length; i += 1) {
    const entry = shape.entries[i]!;
    if (entry.key === "content") continue;
    defineOwnDataProperty(projected, entry.key, cloneStrictJson(entry.value));
  }
  return projected;
}

function matchesStructuredContentText(text: string, clonedStructured: unknown): boolean {
  if (text === canonicalJson(clonedStructured)) return true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isLosslessCanonicalJsonText(text)) return false;
  if (collectStrictJsonContainers(parsed) === null) return false;
  return jsonValuesEqual(parsed, clonedStructured);
}

type JsonContainerFrame =
  | { kind: "obj"; keys: Set<string>; expectingKey: boolean }
  | { kind: "arr" };

/**
 * Verifies RFC-8259 valid JSON text has no duplicate object keys (even via
 * escapes) and every unquoted numeric literal round-trips cleanly through
 * IEEE-754 `Number` and `JSON.stringify`.
 */
function isLosslessCanonicalJsonText(text: string): boolean {
  const stack: JsonContainerFrame[] = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 34) {
      const start = i;
      i += 1;
      while (i < text.length) {
        const inner = text.charCodeAt(i);
        if (inner === 92) {
          i += 2;
          continue;
        }
        if (inner === 34) break;
        i += 1;
      }
      const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
      if (top?.kind === "obj" && top.expectingKey) {
        const key = JSON.parse(text.slice(start, i + 1)) as string;
        if (top.keys.has(key)) return false;
        top.keys.add(key);
      }
      continue;
    }
    if (ch === 123) {
      pushOwn(stack, { kind: "obj", keys: new Set<string>(), expectingKey: true });
    } else if (ch === 91) {
      pushOwn(stack, { kind: "arr" });
    } else if (ch === 125 || ch === 93) {
      if (stack.length > 0) stack.length -= 1;
    } else if (ch === 58) {
      const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
      if (top?.kind === "obj") top.expectingKey = false;
    } else if (ch === 44) {
      const top = stack.length > 0 ? stack[stack.length - 1] : undefined;
      if (top?.kind === "obj") top.expectingKey = true;
    } else if (ch === 45 || (ch >= 48 && ch <= 57)) {
      const start = i;
      i += 1;
      while (i < text.length && isJsonNumberChar(text.charCodeAt(i))) i += 1;
      const tok = text.slice(start, i);
      const num = Number(tok);
      if (!Number.isFinite(num) || JSON.stringify(num) !== tok) return false;
      i -= 1;
    }
  }
  return true;
}

function isJsonNumberChar(code: number): boolean {
  return (code >= 48 && code <= 57) || code === 46 || code === 101 || code === 69 || code === 43 || code === 45;
}

type StrictJsonFrame = { node: unknown; phase: "enter" | "exit" };
type JsonEqualFrame = { left: unknown; right: unknown; phase: "enter" | "exit" };

/**
 * Side-effect-free iterative Stage-1 guard collecting unique container objects while rejecting
 * non-JSON primitives, cycles, symbols, accessors, and fast exotic/non-plain objects without CDP.
 */
function collectStrictJsonContainers(root: unknown): object[] | null {
  const active = new Set<object>();
  const collected = new Set<object>();
  const containers: object[] = [];
  const stack: StrictJsonFrame[] = [{ node: root, phase: "enter" }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    stack.length -= 1;
    if (frame.phase === "exit") {
      const exited = frame.node as object;
      active.delete(exited);
      if (!collected.has(exited)) {
        collected.add(exited);
        pushOwn(containers, exited);
      }
      continue;
    }
    const value = frame.node;
    if (value === null || typeof value === "boolean" || typeof value === "string") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return null;
      continue;
    }
    if (typeof value !== "object" || hasFastExoticInternalSlots(value, isZeroPropCloneable) || active.has(value)) {
      return null;
    }
    if (collected.has(value)) continue;
    active.add(value);
    pushOwn(stack, { node: value, phase: "exit" });
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return null;
      if (Object.getOwnPropertySymbols(value).length > 0) return null;
      if (Object.getOwnPropertyNames(value).length !== value.length + 1) return null;
      for (let i = value.length - 1; i >= 0; i -= 1) {
        const desc = Object.getOwnPropertyDescriptor(value, i);
        if (desc === undefined || desc.enumerable !== true || !Object.hasOwn(desc, "value")) return null;
        pushOwn(stack, { node: desc.value, phase: "enter" });
      }
      continue;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return null;
    if (Object.getOwnPropertySymbols(value).length > 0) return null;
    const keys = Object.getOwnPropertyNames(value);
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i]!;
      const desc = Object.getOwnPropertyDescriptor(value, key);
      if (desc === undefined || desc.enumerable !== true || !Object.hasOwn(desc, "value")) return null;
      pushOwn(stack, { node: desc.value, phase: "enter" });
    }
  }
  return containers;
}

/**
 * Two-stage order-independent strict-JSON guard:
 * Stage 1 validates finite/plain/cycle/symbol/fast-exotic invariants across the entire graph;
 * Stage 2 verifies structured-clone roundtrip equivalence.
 */
function isStrictJsonData(root: unknown): boolean {
  if (collectStrictJsonContainers(root) === null) return false;
  if (root !== null && typeof root === "object") {
    let cloneable = false;
    try {
      const cloned = structuredClone(root);
      cloneable = isClonedPlainTree(cloned, root) && jsonValuesEqual(cloned, root);
    } catch (err) {
      if (!(err instanceof RangeError)) return false;
      cloneable = verifyDeepCloneableTree(root);
    }
    if (!cloneable) return false;
  }
  return true;
}

const LIGHT_CAP = 256;
const CHAIN_STEP = 512;

type DeepCloneFrame = {
  node: object;
  children: object[];
  childIndex: number;
  maxChildHeight: number;
  lightChildren: object[];
  heavyChildren: object[];
  heavyChildChainLen: number;
};

function isClonedPlainTree(cloned: unknown, expectedRoot: object): boolean {
  if (cloned === null || typeof cloned !== "object" || Array.isArray(cloned) !== Array.isArray(expectedRoot)) {
    return false;
  }
  const seen = new Set<object>();
  const stack: unknown[] = [cloned];
  while (stack.length > 0) {
    const cur = stack[stack.length - 1];
    stack.length -= 1;
    if (cur === null || typeof cur === "boolean" || typeof cur === "string") continue;
    if (typeof cur === "number") {
      if (!Number.isFinite(cur)) return false;
      continue;
    }
    if (typeof cur !== "object") return false;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Object.getOwnPropertySymbols(cur).length > 0) return false;
    if (Array.isArray(cur)) {
      if (Object.getPrototypeOf(cur) !== Array.prototype) return false;
      for (let i = 0; i < cur.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(cur, i);
        if (desc === undefined || desc.enumerable !== true || !Object.hasOwn(desc, "value")) return false;
        pushOwn(stack, desc.value);
      }
    } else {
      if (Object.getPrototypeOf(cur) !== Object.prototype) return false;
      const keys = Object.getOwnPropertyNames(cur);
      for (let i = 0; i < keys.length; i += 1) {
        const desc = Object.getOwnPropertyDescriptor(cur, keys[i]!);
        if (desc === undefined || desc.enumerable !== true || !Object.hasOwn(desc, "value")) return false;
        pushOwn(stack, desc.value);
      }
    }
  }
  return true;
}

function probeClone(node: object, allowRangeError: boolean): boolean {
  try {
    const cloned = structuredClone(node);
    return isClonedPlainTree(cloned, node) && jsonValuesEqual(cloned, node);
  } catch (err) {
    return allowRangeError && err instanceof RangeError;
  }
}

function createDeepCloneFrame(node: object): DeepCloneFrame {
  const children: object[] = [];
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const v = Object.getOwnPropertyDescriptor(node, i)!.value;
      if (v !== null && typeof v === "object") pushOwn(children, v);
    }
  } else {
    const keys = Object.getOwnPropertyNames(node);
    for (let i = 0; i < keys.length; i += 1) {
      const v = Object.getOwnPropertyDescriptor(node, keys[i]!)!.value;
      if (v !== null && typeof v === "object") pushOwn(children, v);
    }
  }
  return { node, children, childIndex: 0, maxChildHeight: 0, lightChildren: [], heavyChildren: [], heavyChildChainLen: 0 };
}

/**
 * Verifies deep strict-JSON trees (> structuredClone's native recursion cap) via
 * iterative bottom-up heavy-light decomposition so no uncloneable exotic object
 * can hide behind a `RangeError`.
 */
function verifyDeepCloneableTree(root: object): boolean {
  const memo = new Map<object, { height: number; chainLen: number }>();
  const stack: DeepCloneFrame[] = [createDeepCloneFrame(root)];
  while (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    let descended = false;
    while (top.childIndex < top.children.length) {
      const child = top.children[top.childIndex]!;
      const cached = memo.get(child);
      if (cached === undefined) {
        pushOwn(stack, createDeepCloneFrame(child));
        descended = true;
        break;
      }
      top.childIndex += 1;
      if (cached.height > top.maxChildHeight) top.maxChildHeight = cached.height;
      if (cached.height <= LIGHT_CAP) {
        pushOwn(top.lightChildren, child);
      } else {
        pushOwn(top.heavyChildren, child);
        top.heavyChildChainLen = cached.chainLen;
      }
    }
    if (descended) continue;
    stack.length -= 1;
    const height = 1 + top.maxChildHeight;
    let chainLen = 0;
    if (height <= LIGHT_CAP) {
      if (top.node === root) return probeClone(top.node, false);
    } else if (height === LIGHT_CAP + 1) {
      if (!probeClone(top.node, false)) return false;
    } else {
      for (let i = 0; i < top.lightChildren.length; i += 1) {
        if (!probeClone(top.lightChildren[i]!, false)) return false;
      }
      if (top.heavyChildren.length >= 2) {
        if (!probeClone(top.node, true)) return false;
        for (let i = 0; i < top.heavyChildren.length; i += 1) {
          if (!probeClone(top.heavyChildren[i]!, true)) return false;
        }
      } else {
        chainLen = top.heavyChildChainLen + 1;
        if (chainLen >= CHAIN_STEP) {
          if (!probeClone(top.node, true)) return false;
          chainLen = 0;
        }
      }
    }
    if (top.node === root) {
      if (height > LIGHT_CAP + 1 && chainLen > 0 && !probeClone(root, true)) return false;
      return true;
    }
    memo.set(top.node, { height, chainLen });
  }
  return true;
}

type CloneEntry = { target: unknown[] | Record<string, unknown>; key: string | number; src: unknown };

/**
 * Iteratively deep-clones pre-validated strict JSON data via own descriptors
 * and `Object.defineProperty` so projected results share zero mutable objects
 * or arrays with the source envelope and never trigger `[[Set]]` prototype traps.
 */
function cloneStrictJson(root: unknown): unknown {
  if (root === null || typeof root !== "object") return root;
  const createShell = (src: object): unknown[] | Record<string, unknown> =>
    Array.isArray(src) ? [] : Object.getPrototypeOf(src) === null ? Object.create(null) : {};
  const clonedBySrc = new Map<object, unknown[] | Record<string, unknown>>();
  const cloneRoot = createShell(root);
  clonedBySrc.set(root, cloneRoot);
  const stack: CloneEntry[] = [];
  const pushChildren = (src: object, target: unknown[] | Record<string, unknown>): void => {
    if (Array.isArray(src)) {
      for (let i = src.length - 1; i >= 0; i -= 1) {
        pushOwn(stack, { target, key: i, src: Object.getOwnPropertyDescriptor(src, i)!.value });
      }
    } else {
      const keys = Object.getOwnPropertyNames(src);
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const key = keys[i]!;
        pushOwn(stack, { target, key, src: Object.getOwnPropertyDescriptor(src, key)!.value });
      }
    }
  };
  pushChildren(root, cloneRoot);
  while (stack.length > 0) {
    const entry = stack[stack.length - 1]!;
    stack.length -= 1;
    let nextValue = entry.src;
    if (entry.src !== null && typeof entry.src === "object") {
      let childShell = clonedBySrc.get(entry.src);
      if (childShell === undefined) {
        childShell = createShell(entry.src);
        clonedBySrc.set(entry.src, childShell);
        pushChildren(entry.src, childShell);
      }
      nextValue = childShell;
    }
    defineOwnDataProperty(entry.target, entry.key, nextValue);
  }
  return cloneRoot;
}

function defineOwnDataProperty(obj: object, key: PropertyKey, value: unknown): void {
  Object.defineProperty(obj, key, { __proto__: null, value, writable: true, enumerable: true, configurable: true } as PropertyDescriptor);
}

function pushOwn<T>(arr: T[], item: T): void {
  defineOwnDataProperty(arr, arr.length, item);
}

function jsonValuesEqual(leftRoot: unknown, rightRoot: unknown): boolean {
  const activeRight = new Set<object>();
  const paired = new Map<object, Set<object>>();
  const stack: JsonEqualFrame[] = [{ left: leftRoot, right: rightRoot, phase: "enter" }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    stack.length -= 1;
    if (frame.phase === "exit") {
      activeRight.delete(frame.right as object);
      continue;
    }
    const { left, right } = frame;
    if (Object.is(left, right) || (left === 0 && right === 0)) continue;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
      return false;
    }
    if (activeRight.has(right)) return false;
    let seenForLeft = paired.get(left);
    if (seenForLeft?.has(right)) continue;
    if (seenForLeft === undefined) {
      seenForLeft = new Set<object>();
      paired.set(left, seenForLeft);
    }
    seenForLeft.add(right);
    activeRight.add(right);
    pushOwn(stack, { left, right, phase: "exit" });
    if (Array.isArray(left) || Array.isArray(right)) {
      if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
      for (let i = left.length - 1; i >= 0; i -= 1) {
        if (!Object.hasOwn(right, i)) return false;
        pushOwn(stack, { left: left[i], right: right[i], phase: "enter" });
      }
      continue;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (let i = 0; i < leftKeys.length; i += 1) {
      const key = leftKeys[i]!;
      if (!Object.hasOwn(right, key)) return false;
      pushOwn(stack, { left: (left as Record<string, unknown>)[key], right: (right as Record<string, unknown>)[key], phase: "enter" });
    }
  }
  return true;
}

function isZeroPropCloneable(value: object): boolean {
  try {
    const cloned = structuredClone(value);
    return isClonedPlainTree(cloned, value) && jsonValuesEqual(cloned, value);
  } catch {
    return false;
  }
}

function isPlainNonProxyObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || hasFastExoticInternalSlots(value, isZeroPropCloneable) || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
