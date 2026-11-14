/** Local JSON Pointer (`#` / `#/…`) with RFC 6901 unescaping. Object steps only. */

export function unescapeJsonPointerToken(token: string): string {
  return token.replace(/~1/gu, "/").replace(/~0/gu, "~");
}

export function readLocalJsonPointer(root: unknown, pointer: string): unknown {
  if (pointer === "#") {
    return root;
  }
  if (!pointer.startsWith("#/")) {
    return undefined;
  }
  let current: unknown = root;
  for (const part of pointer.slice(2).split("/")) {
    if (current === null || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[unescapeJsonPointerToken(part)];
  }
  return current;
}
