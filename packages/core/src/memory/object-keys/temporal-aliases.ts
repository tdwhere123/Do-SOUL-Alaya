import { normalizeMemoryObjectKeySurface } from "@do-soul/alaya-protocol";
import { formMemoryObjectKey } from "./form-key.js";
import { occupies } from "./occupancy.js";
import { titleCaseMonth } from "./month-names.js";
import {
  extractCalendarSurfaces,
  extractRelativeSurfaces,
  type CalendarSurfaceHit,
  type RelativeSurfaceHit
} from "./temporal-extract.js";
import type { DraftMemoryObjectKey, MintableEvidence } from "./types.js";

export function mintTemporalAliasKeys(input: Readonly<{
  readonly workspace_id: string;
  readonly owner_id: string;
  readonly memory_content: string;
  readonly evidence: readonly Readonly<MintableEvidence>[];
  readonly occupied: ReadonlySet<string>;
}>): readonly ReturnType<typeof formMemoryObjectKey>[] {
  const contentNormalized = normalizeMemoryObjectKeySurface(input.memory_content);
  const sources = sourceTexts(input);
  return Object.freeze(sources.flatMap((source) => [
    ...calendarAliasKeys(input, source, contentNormalized),
    ...relativeAliasKeys(input, source, contentNormalized)
  ]));
}

function sourceTexts(input: Readonly<{
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

function calendarAliasKeys(
  input: Readonly<{
    readonly workspace_id: string;
    readonly owner_id: string;
    readonly occupied: ReadonlySet<string>;
  }>,
  source: Readonly<{ readonly text: string; readonly sourceRef: string }>,
  contentNormalized: string
): readonly ReturnType<typeof formMemoryObjectKey>[] {
  return extractCalendarSurfaces(source.text).flatMap((hit) =>
    calendarAliases(hit).flatMap((surface) =>
      occupies(surface, input.occupied, contentNormalized)
        ? []
        : [formMemoryObjectKey(aliasDraft(input, surface, source.sourceRef, hit.surface))]
    )
  );
}

function relativeAliasKeys(
  input: Readonly<{
    readonly workspace_id: string;
    readonly owner_id: string;
    readonly occupied: ReadonlySet<string>;
  }>,
  source: Readonly<{ readonly text: string; readonly sourceRef: string }>,
  contentNormalized: string
): readonly ReturnType<typeof formMemoryObjectKey>[] {
  return extractRelativeSurfaces(source.text).flatMap((hit) =>
    relativeAliases(hit).flatMap((surface) =>
      occupies(surface, input.occupied, contentNormalized)
        ? []
        : [formMemoryObjectKey(aliasDraft(input, surface, source.sourceRef, hit.surface))]
    )
  );
}

function calendarAliases(hit: Readonly<CalendarSurfaceHit>): readonly string[] {
  const monthName = titleCaseMonth(hit.month);
  if (monthName === null) return [];
  const aliases = [monthName, `${hit.month}月`];
  if (hit.day !== null) {
    aliases.push(`${monthName} ${hit.day}`, `${hit.month}/${hit.day}`, `${hit.month}月${hit.day}日`);
  }
  if (hit.year !== null && hit.day !== null) {
    aliases.push(`${hit.year}-${pad(hit.month)}-${pad(hit.day)}`, `${hit.year}年${hit.month}月${hit.day}日`);
  }
  return aliases.filter((surface) =>
    normalizeMemoryObjectKeySurface(surface) !== normalizeMemoryObjectKeySurface(hit.surface)
  );
}

function relativeAliases(hit: Readonly<RelativeSurfaceHit>): readonly string[] {
  const englishUnit = hit.unit === "day" && hit.count !== 1 ? "days" : `${hit.unit}${hit.count === 1 ? "" : "s"}`;
  const cjkUnit = { day: "天", week: "周", month: "个月", year: "年" }[hit.unit];
  return [`${hit.count} ${englishUnit} ago`, `${hit.count}${cjkUnit}前`].filter((surface) =>
    normalizeMemoryObjectKeySurface(surface) !== normalizeMemoryObjectKeySurface(hit.surface)
  );
}

function aliasDraft(
  input: Readonly<{ readonly workspace_id: string; readonly owner_id: string }>,
  surface: string,
  sourceRef: string,
  original: string
): DraftMemoryObjectKey {
  return {
    workspace_id: input.workspace_id,
    owner_id: input.owner_id,
    key_type: "temporal_alias",
    surface,
    language: /[\p{Script=Han}]/u.test(surface) ? "zh" : "en",
    source_kind: "stored_text",
    source_ref: `${sourceRef}:surface:${original}`
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
