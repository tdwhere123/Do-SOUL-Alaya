export interface SeparabilityDiagnostics {
  readonly questions: readonly unknown[];
}

export interface SeparabilityCohort {
  readonly rows: readonly { readonly question_id: string }[];
}

export interface SeparabilityEvidenceOptions {
  readonly cohort?: SeparabilityCohort;
  readonly legacyDiagnostic?: boolean;
}

export function resolveSeparabilityEvidenceMode(
  diagnostics: SeparabilityDiagnostics,
  options: SeparabilityEvidenceOptions & {
    readonly cohort: SeparabilityCohort;
    readonly legacyDiagnostic?: false;
  }
): ReadonlyMap<string, unknown>;

export function resolveSeparabilityEvidenceMode(
  diagnostics: SeparabilityDiagnostics,
  options: SeparabilityEvidenceOptions & {
    readonly cohort?: undefined;
    readonly legacyDiagnostic: true;
  }
): null;
