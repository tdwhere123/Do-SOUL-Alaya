export interface SyntheticScenario {
  readonly id: string;
  readonly version: number;
  readonly category: "preference" | "decision" | "fact" | "feedback" | "project_status";
  readonly setup: ReadonlyArray<string>;
  readonly probe: string;
  readonly expected_keywords: ReadonlyArray<string>;
}

export const SYNTHETIC_SCENARIOS: ReadonlyArray<SyntheticScenario> = [];
