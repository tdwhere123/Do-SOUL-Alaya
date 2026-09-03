import process from "node:process";
import { runExtractionFill } from "../../runs/extraction/extraction-fill.js";
import type { ParsedFlags } from "../cli-options.js";
import { readR3SpendApproval } from "../../datasets/longmemeval/promotion/r3-spend-approval.js";
import {
  runExtractionFillCommand as runCommand,
  type ExtractionFillCommandDependencies
} from "./command-core.js";
import type { ExtractionFillLazyFlags } from "./lazy-field-flags.js";

export type { ExtractionFillCommandDependencies } from "./command-core.js";
export type { ExtractionFillLazyFlags } from "./lazy-field-flags.js";

const DEFAULT_DEPENDENCIES: ExtractionFillCommandDependencies = {
  runExtractionFill,
  signalSource: process,
  readR3SpendApproval
};

export function runExtractionFillCommand(
  opts: ParsedFlags,
  deps?: ExtractionFillCommandDependencies,
  lazy: ExtractionFillLazyFlags = {}
): Promise<number> {
  return runCommand(opts, deps ?? DEFAULT_DEPENDENCIES, lazy);
}
