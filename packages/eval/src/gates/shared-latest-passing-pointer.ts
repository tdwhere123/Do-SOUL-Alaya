import type { BenchName, BenchSplit } from "../contracts/kpi-schema.js";

/**
 * One bench root owns a single `latest-passing*.json` chain, shared by every
 * split archived under that root. These splits can carry verified evidence but
 * have no applicable release gate, so advancing that chain would publish an
 * ungated run as the root's passing baseline. Their archives and
 * `latest-run*.json` pointers are unaffected. The maintained-content CI
 * imports this module directly, so it must stay free of runtime imports.
 */
const SHARED_POINTER_INELIGIBLE_SURFACES = [
  ["public", "longmemeval-oracle"],
  ["public", "longmemeval-m"]
] as const satisfies readonly (readonly [BenchName, BenchSplit])[];

const SHARED_POINTER_INELIGIBLE_KEYS: ReadonlySet<string> = new Set(
  SHARED_POINTER_INELIGIBLE_SURFACES.map(([benchName, split]) =>
    `${benchName}\u0000${split}`
  )
);

export function canAdvanceSharedLatestPassingPointer(surface: {
  readonly bench_name: BenchName;
  readonly split: BenchSplit;
}): boolean {
  return !SHARED_POINTER_INELIGIBLE_KEYS.has(
    `${surface.bench_name}\u0000${surface.split}`
  );
}
