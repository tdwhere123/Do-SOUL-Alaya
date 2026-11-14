import { describe, expect, it } from "vitest";
import { readLocalJsonPointer, unescapeJsonPointerToken } from "../../shared/json-pointer.js";

describe("readLocalJsonPointer", () => {
  it("reads object steps with RFC 6901 unescaping", () => {
    const root = { a: { "b/c": { "~d": 1 } } };
    expect(unescapeJsonPointerToken("b~1c")).toBe("b/c");
    expect(unescapeJsonPointerToken("~0d")).toBe("~d");
    expect(readLocalJsonPointer(root, "#")).toEqual(root);
    expect(readLocalJsonPointer(root, "#/a/b~1c/~0d")).toBe(1);
  });

  it("returns undefined for non-local or unresolved pointers", () => {
    expect(readLocalJsonPointer({ a: 1 }, "a")).toBeUndefined();
    expect(readLocalJsonPointer({ a: 1 }, "#/missing")).toBeUndefined();
    expect(readLocalJsonPointer({ a: [1] }, "#/a/0")).toBeUndefined();
  });
});
