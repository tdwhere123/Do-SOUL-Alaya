import type { DraftMemoryObjectKey, MintableEvidence } from "../types.js";

export function aliasSourceTexts(input: Readonly<{
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: readonly Readonly<MintableEvidence>[];
}>): readonly Readonly<{ readonly text: string; readonly sourceRef: string }>[] {
  return Object.freeze([
    {
      text: input.memory_content,
      sourceRef: `memory:${input.owner_id}:content`
    },
    ...input.evidence.map((item) => ({
      text: item.gist,
      sourceRef: `evidence:${item.object_id}:gist`
    }))
  ]);
}

export function aliasKeyDraft(
  input: Readonly<{ readonly workspace_id: string; readonly owner_id: string }>,
  keyType: "temporal_alias" | "numeric_alias",
  surface: string,
  sourceRef: string,
  original: string
): DraftMemoryObjectKey {
  return {
    workspace_id: input.workspace_id,
    owner_id: input.owner_id,
    key_type: keyType,
    surface,
    language: /[\p{Script=Han}]/u.test(surface) ? "zh" : "en",
    source_kind: "stored_text",
    source_ref: `${sourceRef}:surface:${original}`
  };
}
