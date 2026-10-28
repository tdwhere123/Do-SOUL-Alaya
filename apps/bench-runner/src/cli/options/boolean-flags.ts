import type { ParsedFlagsState } from "../cli-options.js";
import { AlayaError, parseEnvBoolean } from "@do-soul/alaya-protocol";

export function consumeBooleanFlags(
  _args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number {
  const [flag, value] = token.split("=", 2);
  const fields: Readonly<Record<string, keyof Pick<ParsedFlagsState,
    "force" | "extractionOpenSemantics" | "qa" | "edgePlane" | "materializeQuestionDbs" |
    "experiment" | "tolerateProviderTaskFailures" | "rebuildEvidenceSearchProjections" |
    "backfillMissingFactFrameFormations">>> = {
    "--force": "force", "--extraction-open-semantics": "extractionOpenSemantics",
    "--qa": "qa", "--answer-judge": "qa", "--edge-plane": "edgePlane",
    "--materialize-question-dbs": "materializeQuestionDbs", "--experiment": "experiment",
    "--tolerate-provider-task-failures": "tolerateProviderTaskFailures",
    "--rebuild-evidence-search-projections": "rebuildEvidenceSearchProjections",
    "--backfill-missing-fact-frame-formations": "backfillMissingFactFrameFormations"
  };
  const field = fields[flag ?? ""];
  if (field === undefined) throw new AlayaError("VALIDATION", `Unknown benchmark argument: ${token}`);
  if (value !== undefined && value.trim().length === 0) throw new AlayaError("VALIDATION", `${flag} requires a boolean value`);
  state[field] = value === undefined ? true : parseEnvBoolean(token.slice(token.indexOf("=") + 1), flag ?? token);
  return index;
}
