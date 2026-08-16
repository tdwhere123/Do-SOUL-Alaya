export type SelectGammaSynthesisInput = Readonly<{
  readonly selected_candidate_keys: readonly string[];
  readonly synthesize?: () => SelectGammaSynthesisOutput;
}>;

export type SelectGammaSynthesisOutput = Readonly<{
  readonly text: string;
  readonly truncated?: boolean;
  readonly selected_candidate_keys?: readonly string[];
}>;

export type SelectGammaSynthesisResult = Readonly<{
  readonly selected_candidate_keys: readonly string[];
  readonly synthesis: SelectGammaSynthesisStatus;
}>;

export type SelectGammaSynthesisStatus =
  | Readonly<{ readonly status: "absent" }>
  | Readonly<{ readonly status: "ok"; readonly text: string }>
  | Readonly<{
      readonly status: "malformed" | "truncated";
      readonly failure: string;
      readonly text?: string;
    }>;

export function applySelectGammaSynthesis(
  input: SelectGammaSynthesisInput
): SelectGammaSynthesisResult {
  const selected = Object.freeze([...input.selected_candidate_keys]);
  if (input.synthesize === undefined) {
    return Object.freeze({
      selected_candidate_keys: selected,
      synthesis: Object.freeze({ status: "absent" as const })
    });
  }
  return Object.freeze({
    selected_candidate_keys: selected,
    synthesis: readSynthesis(input.synthesize)
  });
}

function readSynthesis(
  synthesize: () => SelectGammaSynthesisOutput
): SelectGammaSynthesisStatus {
  try {
    const output = synthesize();
    if (output.truncated === true) {
      return Object.freeze({
        status: "truncated" as const,
        failure: "synthesis output truncated",
        text: output.text
      });
    }
    if (typeof output.text !== "string" || output.text.trim().length === 0) {
      return Object.freeze({
        status: "malformed" as const,
        failure: "synthesis output is empty"
      });
    }
    return Object.freeze({ status: "ok" as const, text: output.text });
  } catch (error) {
    return Object.freeze({
      status: "malformed" as const,
      failure: error instanceof Error ? error.message : "synthesis failed"
    });
  }
}
