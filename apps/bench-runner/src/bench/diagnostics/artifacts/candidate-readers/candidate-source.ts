import type { DiagnosticCandidateIdentityMode } from "../../candidate-identity.js";

export type DiagnosticCandidateSource = Readonly<{
  readonly rows: readonly unknown[];
  readonly mode: DiagnosticCandidateIdentityMode;
}>;

export function readDiagnosticCandidateSource(
  diagnostics: Readonly<Record<string, unknown>>
): DiagnosticCandidateSource | null {
  const legacy = asArray(diagnostics.candidate_pool) ?? asArray(diagnostics.pool);
  if (legacy !== null) return { rows: legacy, mode: "legacy" };
  const strict = asArray(diagnostics.candidates);
  return strict === null ? null : { rows: strict, mode: "strict" };
}

function asArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}
