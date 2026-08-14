import { normalizeMemoryObjectKeySurface, type MemoryObjectKey } from "@do-soul/alaya-protocol";
import { aliasKeyDraft, aliasSourceTexts } from "./alias-source.js";
import { formedKey } from "./form-key.js";
import { occupies } from "./occupancy.js";
import { extractNumericSurfaces } from "../normalize/numeric-extract.js";
import { numericAliasSurfaces } from "../normalize/numeric-words.js";
import type { MintableEvidence } from "../types.js";

export function mintNumericAliasKeys(input: Readonly<{
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: readonly Readonly<MintableEvidence>[];
  readonly occupied: ReadonlySet<string>;
}>): readonly Readonly<MemoryObjectKey>[] {
  const contentNormalized = normalizeMemoryObjectKeySurface(input.memory_content);
  return Object.freeze(aliasSourceTexts(input).flatMap((source) =>
    extractNumericSurfaces(source.text).flatMap((hit) =>
      numericAliasSurfaces(hit.value, hit.surface).flatMap((surface) =>
        occupies(surface, input.occupied, contentNormalized)
          ? []
          : formedKey(aliasKeyDraft(input, "numeric_alias", surface, source.sourceRef, hit.surface))
      )
    )
  ));
}

export function complementaryNumericAliasSurfaces(text: string): readonly string[] {
  return Object.freeze(extractNumericSurfaces(text).flatMap((hit) =>
    numericAliasSurfaces(hit.value, hit.surface)
  ));
}
