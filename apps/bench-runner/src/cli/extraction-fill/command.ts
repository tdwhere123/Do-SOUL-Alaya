import process from "node:process";
import { runExtractionFill } from "../../longmemeval/extraction/extraction-fill.js";
import type { ParsedFlags } from "../cli-options.js";
import { verifyLongMemEvalExpansionContractInput } from "../promotion/expansion-input.js";
import { readR3SpendApproval } from "../../longmemeval/promotion/r3-spend-approval.js";
import {
  runExtractionFillCommand as runCommand,
  type ExtractionFillCommandDependencies
} from "./command-core.js";

export type { ExtractionFillCommandDependencies } from "./command-core.js";

const DEFAULT_DEPENDENCIES: ExtractionFillCommandDependencies = {
  runExtractionFill,
  signalSource: process,
  verifyExpansionContract: verifyLongMemEvalExpansionContractInput,
  readR3SpendApproval
};

export function runExtractionFillCommand(
  opts: ParsedFlags,
  deps: ExtractionFillCommandDependencies = DEFAULT_DEPENDENCIES
): Promise<number> {
  return runCommand(opts, deps);
}
