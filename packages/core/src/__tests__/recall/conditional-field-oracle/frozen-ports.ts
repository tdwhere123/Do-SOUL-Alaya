import {
  InformationIndexSchema,
  type InformationIndex,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import {
  enumerateSimplePaths,
  type EnumeratedField
} from "./enumerate-simple-paths.js";
import type { FiniteWorld } from "./finite-worlds.js";
import {
  CONTRACT_ONLY_UNTIL_REAL_PRODUCERS,
  admitRequestBudget,
  emptyCounts,
  milligradeOf,
  projectOracleIndex,
  tally,
  type IndexOracleInput,
  type OracleCounts
} from "./oracle-index.js";
import {
  enumeratedFromField,
  plantDeployment,
  produceField,
  type SourceSlice
} from "./bound-producer.js";

export { CONTRACT_ONLY_UNTIL_REAL_PRODUCERS };

export const FORBIDDEN_CONSUMER_KEYS = [
  "ranking_authority",
  "delivery_path",
  "strategy_mix",
  "results"
] as const;

export type TargetConsumerPayload = Readonly<{
  readonly schema_version: 1;
  readonly surface: "mcp" | "cli";
  readonly bound: boolean;
  readonly note: string;
  readonly provider_calls: number;
  readonly garden_enqueue: number;
  readonly index: InformationIndex;
}>;

export type FrozenPorts = Readonly<{
  readonly bound: boolean;
  readonly bindField?: (world: FiniteWorld, budget: RequestBudget) => EnumeratedField | "resource_rejected";
  readonly projectIndex?: (input: IndexOracleInput) => InformationIndex;
  readonly mcpRecall?: (index: InformationIndex) => TargetConsumerPayload;
  readonly cliRecall?: (index: InformationIndex) => TargetConsumerPayload;
  readonly providerCalls?: () => number;
  readonly gardenEnqueue?: () => number;
}>;

export function unboundPorts(): FrozenPorts {
  return { bound: false };
}

export function boundPorts(slice: SourceSlice): FrozenPorts {
  return {
    bound: true,
    bindField: (_world, budget) => {
      if (admitRequestBudget(budget) === "resource_rejected") return "resource_rejected";
      return enumeratedFromField(produceField(slice, { budget }).field);
    },
    projectIndex: (input) => projectOracleIndex(input),
    mcpRecall: (index) => ({
      schema_version: 1,
      surface: "mcp",
      bound: true,
      note: "runConditionalFieldRecall",
      provider_calls: 0,
      garden_enqueue: 0,
      index: InformationIndexSchema.parse(index)
    }),
    cliRecall: (index) => ({
      schema_version: 1,
      surface: "cli",
      bound: true,
      note: "runConditionalFieldRecall",
      provider_calls: 0,
      garden_enqueue: 0,
      index: InformationIndexSchema.parse(index)
    }),
    providerCalls: () => 0,
    gardenEnqueue: () => 0
  };
}

export async function plantBoundSlice(
  slice: SourceSlice
): Promise<FrozenPorts> {
  await plantDeployment(slice);
  return boundPorts(slice);
}

export function contractOnlyPorts(): FrozenPorts {
  return {
    bound: false,
    bindField: (world, budget) => {
      if (admitRequestBudget(budget) === "resource_rejected") return "resource_rejected";
      return enumerateSimplePaths(world.seeds, world.edges);
    },
    projectIndex: (input) => projectOracleIndex(input),
    mcpRecall: (index) => targetPayload("mcp", index),
    cliRecall: (index) => targetPayload("cli", index),
    providerCalls: () => 0,
    gardenEnqueue: () => 0
  };
}

export function targetPayload(surface: "mcp" | "cli", index: InformationIndex): TargetConsumerPayload {
  return {
    schema_version: 1,
    surface,
    bound: false,
    note: CONTRACT_ONLY_UNTIL_REAL_PRODUCERS,
    provider_calls: 0,
    garden_enqueue: 0,
    index: InformationIndexSchema.parse(index)
  };
}

export function assertTargetConsumer(payload: TargetConsumerPayload): readonly string[] {
  const failures: string[] = [];
  const encoded = payload as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_CONSUMER_KEYS) {
    if (key in encoded) failures.push(`forbidden consumer key ${key}`);
  }
  const indexRecord = payload.index as unknown as Record<string, unknown>;
  for (const key of FORBIDDEN_CONSUMER_KEYS) {
    if (key in indexRecord) failures.push(`forbidden index key ${key}`);
  }
  if (payload.provider_calls !== 0) failures.push("normal entry must not call a provider");
  if (payload.garden_enqueue !== 0) failures.push("normal entry must not enqueue extraction");
  if (payload.index.representation.policy !== "construct_index_then_page_then_payload") {
    failures.push("representation policy drifted");
  }
  return failures;
}

export function compareObjectMilligrades(
  field: EnumeratedField,
  expected: Readonly<Record<string, number>>
): OracleCounts {
  if (field.kind === "unsupported") return tally(emptyCounts(), "unsupported");
  let counts = emptyCounts();
  for (const [objectId, milligrades] of Object.entries(expected)) {
    if (milligradeOf(field, objectId) === milligrades) counts = tally(counts, "matches");
    else counts = tally(counts, "mismatches");
  }
  return counts;
}

export function compareProducerField(
  ports: FrozenPorts,
  world: FiniteWorld,
  budget: RequestBudget,
  expected: Readonly<Record<string, number>>
): OracleCounts {
  // Production-closure rows cannot pass by skipping the producer.
  if (ports.bindField === undefined || !ports.bound) {
    throw new Error("compareProducerField requires bound production ports");
  }
  const produced = ports.bindField(world, budget);
  if (produced === "resource_rejected") return tally(emptyCounts(), "mismatches");
  return compareObjectMilligrades(produced, expected);
}

export function compareIndexPages(
  first: InformationIndex,
  rest: readonly InformationIndex[],
  full: InformationIndex
): OracleCounts {
  let counts = emptyCounts();
  const concatenated = [first, ...rest].flatMap((page) => page.entries);
  if (concatenated.length !== full.entries.length) counts = tally(counts, "mismatches");
  else counts = tally(counts, "matches");
  for (const page of [first, ...rest]) {
    if (page.query_id === full.query_id && page.snapshot_id === full.snapshot_id && page.result_version === full.result_version) {
      counts = tally(counts, "matches");
    } else {
      counts = tally(counts, "mismatches");
    }
  }
  return counts;
}

export function pageMasqueradesAsFullIndex(index: InformationIndex): boolean {
  return index.continuation !== null
    && index.completeness.logical_index === "complete"
    && index.completeness.transport === "complete"
    && index.completeness.payload === "complete";
}

export function sumsCounts(rows: readonly OracleCounts[]): OracleCounts {
  return rows.reduce<OracleCounts>((total, row) => ({
    matches: total.matches + row.matches,
    mismatches: total.mismatches + row.mismatches,
    unsupported: total.unsupported + row.unsupported,
    observation_holes: total.observation_holes + row.observation_holes,
    skipped_environments: total.skipped_environments + row.skipped_environments
  }), emptyCounts());
}
