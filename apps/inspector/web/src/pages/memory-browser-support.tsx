export interface MemoryEntryRow {
  readonly object_id: string;
  readonly object_kind: string;
  readonly content: string;
  readonly dimension: string;
  readonly scope_class: string;
  readonly domain_tags: readonly string[];
  readonly evidence_refs: readonly string[];
  readonly created_at: string;
  readonly contradiction_count?: number | null;
  readonly source_kind?: string | null;
  readonly storage_tier?: string | null;
  readonly activation_score?: number | null;
}

export interface MemoryEntryListEnvelope {
  readonly success: boolean;
  readonly data: readonly MemoryEntryRow[];
}

export interface EvidenceCapsuleShape {
  readonly object_id: string;
  readonly object_kind: string;
  readonly gist?: string | null;
  readonly excerpt?: string | null;
}

export interface EvidenceEnvelope {
  readonly success: boolean;
  readonly data: EvidenceCapsuleShape;
}

export interface PromoteEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly proposal_id: string;
    readonly status: "created";
    readonly target_object_id: string;
    readonly target_object_kind: "path_relation";
    readonly requested_governance_class: "strictly_governed";
  };
}

export interface MemoryPageData {
  readonly rows: readonly MemoryEntryRow[];
  readonly totalRows: number | null;
  readonly nextOffset: number;
  readonly hasMoreRows: boolean;
}

export type DimensionFilter = "all" | string;
export type ScopeFilter = "all" | string;
export type ConflictFilter = "any" | "has_conflict";

export const DIMENSION_OPTIONS: readonly string[] = [
  "preference",
  "procedure",
  "constraint",
  "hazard",
  "concept",
  "outcome"
];

export const SCOPE_OPTIONS: readonly string[] = ["project", "global_domain", "global_core"];

export const MEMORY_PAGE_SIZE = 200;
export const MEMORY_RETAINED_ROWS_MAX = 5_000;


export function FilterChipGroup(props: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
  readonly onChange: (next: string) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-mono uppercase tracking-widest text-ink-500">
        {props.label}:
      </span>
      {props.options.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => props.onChange(option)}
          className={`px-2 py-0.5 text-[10px] font-mono uppercase border ${
            props.value === option
              ? "bg-ink-600 text-beige-50 border-ink-600"
              : "border-beige-300 text-ink-600 hover:bg-beige-100"
          }`}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export function formatRatio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

export function retainLoadedMemoryRowWindow(
  previous: readonly MemoryEntryRow[],
  pageRows: readonly MemoryEntryRow[],
  maxRows = MEMORY_RETAINED_ROWS_MAX
): readonly MemoryEntryRow[] {
  const merged = [...previous, ...pageRows];
  if (merged.length <= maxRows) {
    return merged;
  }
  return merged.slice(merged.length - maxRows);
}

export function readOptionalIntegerHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (value === null || value.trim().length === 0) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
