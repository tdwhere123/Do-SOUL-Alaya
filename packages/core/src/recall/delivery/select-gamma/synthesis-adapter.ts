import type { RecallCandidate } from "@do-soul/alaya-protocol";

export interface SelectGammaSynthesisPort {
  synthesize(
    input: Readonly<{
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly query_text: string | null;
      readonly selected_evidence: readonly Readonly<RecallCandidate>[];
    }>
  ): Promise<unknown>;
}

export type SelectGammaSynthesisDependencies = Readonly<{
  readonly selectGammaSynthesisPort?: SelectGammaSynthesisPort;
}>;

export type SelectGammaSynthesisStatus =
  | Readonly<{ readonly status: "absent" }>
  | Readonly<{ readonly status: "ok"; readonly text: string }>
  | Readonly<{
      readonly status: "malformed" | "truncated" | "failed";
      readonly failure: string;
      readonly text?: string;
    }>;

export type SelectGammaSynthesisResult = Readonly<{
  readonly selected_evidence: readonly Readonly<RecallCandidate>[];
  readonly synthesis: SelectGammaSynthesisStatus;
}>;

export async function applySelectGammaSynthesis(input: Readonly<{
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly query_text: string | null;
  readonly selected_evidence: readonly Readonly<RecallCandidate>[];
  readonly port?: SelectGammaSynthesisPort;
}>): Promise<SelectGammaSynthesisResult> {
  const selectedEvidence = Object.freeze([...input.selected_evidence]);
  if (input.port === undefined) {
    return result(selectedEvidence, Object.freeze({ status: "absent" as const }));
  }
  try {
    const output = await input.port.synthesize(Object.freeze({
      workspace_id: input.workspace_id,
      run_id: input.run_id,
      query_text: input.query_text,
      selected_evidence: selectedEvidence
    }));
    return result(selectedEvidence, parseSynthesisOutput(output));
  } catch (error) {
    return result(selectedEvidence, Object.freeze({
      status: "failed" as const,
      failure: error instanceof Error ? error.message : "synthesis failed"
    }));
  }
}

function parseSynthesisOutput(output: unknown): SelectGammaSynthesisStatus {
  if (!isRecord(output)) return malformed("synthesis output must be an object");
  if (output.truncated !== undefined && typeof output.truncated !== "boolean") {
    return malformed("synthesis truncated marker must be boolean");
  }
  if (output.truncated === true) {
    return Object.freeze({
      status: "truncated" as const,
      failure: "synthesis output truncated",
      ...(typeof output.text === "string" ? { text: output.text } : {})
    });
  }
  if (typeof output.text !== "string" || output.text.trim().length === 0) {
    return malformed("synthesis output text must be non-empty");
  }
  return Object.freeze({ status: "ok" as const, text: output.text });
}

function malformed(failure: string): SelectGammaSynthesisStatus {
  return Object.freeze({ status: "malformed" as const, failure });
}

function result(
  selectedEvidence: readonly Readonly<RecallCandidate>[],
  synthesis: SelectGammaSynthesisStatus
): SelectGammaSynthesisResult {
  return Object.freeze({ selected_evidence: selectedEvidence, synthesis });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
