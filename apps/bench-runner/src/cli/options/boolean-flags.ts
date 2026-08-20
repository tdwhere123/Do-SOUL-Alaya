import type { ParsedFlagsState } from "../cli-options.js";

export function consumeBooleanFlags(
  _args: ReadonlyArray<string>,
  index: number,
  token: string,
  state: ParsedFlagsState
): number {
  if (token === "--force") state.force = true;
  if (token === "--qa" || token === "--answer-judge") state.qa = true;
  if (token === "--edge-plane") state.edgePlane = true;
  if (token === "--materialize-question-dbs") state.materializeQuestionDbs = true;
  if (token === "--experiment") state.experiment = true;
  if (token === "--tolerate-provider-task-failures") {
    state.tolerateProviderTaskFailures = true;
  }
  if (token === "--rebuild-evidence-search-projections") {
    state.rebuildEvidenceSearchProjections = true;
  }
  if (token === "--backfill-missing-fact-frame-formations") {
    state.backfillMissingFactFrameFormations = true;
  }
  return index;
}
