import { normalizeMemoryObjectKeySurface } from "@do-soul/alaya-protocol";
import { aliasKeyDraft, aliasSourceTexts } from "./alias-source.js";
import { formMemoryObjectKey } from "./form-key.js";
import { occupies } from "./occupancy.js";
import { extractNumericSurfaces } from "./numeric-extract.js";
import { numericAliasSurfaces } from "./numeric-words.js";
import type { MintableEvidence } from "./types.js";

export function mintNumericAliasKeys(input: Readonly<{
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: readonly Readonly<MintableEvidence>[];
  readonly occupied: ReadonlySet<string>;
}>): readonly ReturnType<typeof formMemoryObjectKey>[] {
  const contentNormalized = normalizeMemoryObjectKeySurface(input.memory_content);
  return Object.freeze(aliasSourceTexts(input).flatMap((source) =>
    extractNumericSurfaces(source.text).flatMap((hit) =>
      numericAliasSurfaces(hit.value, hit.surface).flatMap((surface) =>
        occupies(surface, input.occupied, contentNormalized)
          ? []
          : [formMemoryObjectKey(aliasKeyDraft(input, "numeric_alias", surface, source.sourceRef, hit.surface))]
      )
    )
  ));
}

export function complementaryNumericAliasSurfaces(text: string): readonly string[] {
  return Object.freeze(extractNumericSurfaces(text).flatMap((hit) =>
    numericAliasSurfaces(hit.value, hit.surface)
  ));
}
