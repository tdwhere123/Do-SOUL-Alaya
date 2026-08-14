import { createHash } from "node:crypto";
import {
  MemoryObjectKeySchema,
  normalizeMemoryObjectKeySurface,
  type MemoryObjectKey
} from "@do-soul/alaya-protocol";
import type { DraftMemoryObjectKey } from "./types.js";

export function formMemoryObjectKey(draft: Readonly<DraftMemoryObjectKey>): Readonly<MemoryObjectKey> | null {
  const normalized = normalizeMemoryObjectKeySurface(draft.surface);
  const parsed = MemoryObjectKeySchema.safeParse({
    ...draft,
    schema_version: 1,
    normalized_surface: normalized,
    key_id: keyId(draft.owner_id, draft.key_type, normalized, draft.source_ref)
  });
  return parsed.success ? parsed.data : null;
}

export function formedKey(draft: Readonly<DraftMemoryObjectKey>): readonly Readonly<MemoryObjectKey>[] {
  const key = formMemoryObjectKey(draft);
  return key === null ? [] : [key];
}

function keyId(
  ownerId: string,
  keyType: string,
  normalizedSurface: string,
  sourceRef: string
): string {
  return createHash("sha256")
    .update([ownerId, keyType, normalizedSurface, sourceRef].join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32);
}
