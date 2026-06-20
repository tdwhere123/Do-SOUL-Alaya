import {
  accrueCoherenceCoRecall,
  accrueSessionCoRecall,
  proposeMemoriesFromCompileSignals,
  proposeMemory,
  proposeMemoryFromSignal,
  proposeSynthesis
} from "./daemon-seed-operations.js";
import type { BenchDaemonHandle } from "./daemon-types.js";
import type { CreateBenchSeedOpsInput } from "./daemon-seed-ops-types.js";

export function createBenchSeedOps(
  input: CreateBenchSeedOpsInput
): Pick<
  BenchDaemonHandle,
  | "proposeMemory"
  | "proposeMemoryFromSignal"
  | "proposeMemoriesFromCompileSignals"
  | "proposeSynthesis"
  | "accrueSessionCoRecall"
  | "accrueCoherenceCoRecall"
> {
  return {
    proposeMemory: (...args) => proposeMemory(input, ...args),
    proposeMemoryFromSignal: (signalInput) =>
      proposeMemoryFromSignal(input, signalInput),
    proposeMemoriesFromCompileSignals: (inputs) =>
      proposeMemoriesFromCompileSignals(input, inputs),
    proposeSynthesis: (synthesisInput) => proposeSynthesis(input, synthesisInput),
    accrueSessionCoRecall: (memberMemoryIds) =>
      accrueSessionCoRecall(input, memberMemoryIds),
    accrueCoherenceCoRecall: (members, options) =>
      accrueCoherenceCoRecall(input, members, options)
  };
}
