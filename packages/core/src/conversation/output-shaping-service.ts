import {
  CommandClass as ProtocolCommandClass,
  CompressionMode,
  FileToolName,
  type CommandClass,
  type CompressionMode as CompressionModeValue,
  type OutputShapingRule
} from "@do-soul/alaya-protocol";

export interface ShapeableOutput {
  readonly event_id: string;
  readonly command_class: CommandClass;
  readonly content: unknown;
}

export interface OutputShapingDecision {
  readonly command_class: CommandClass;
  readonly original_count: number;
  readonly compressed_to: number;
  readonly compression_mode: CompressionMode;
  readonly original_event_ids: readonly string[];
}

export interface OutputShapingDependencies {
  readonly rules: readonly Readonly<OutputShapingRule>[];
}

export interface ShapeBatchResult {
  readonly shaped: readonly unknown[];
  readonly decisions: readonly OutputShapingDecision[];
}

type ShapedBatchEntry = ShapeBatchResult["shaped"][number];
type ShapingDecision = ShapeBatchResult["decisions"][number];

interface CompressionResult {
  readonly shapedOutputs: readonly ShapedBatchEntry[];
  readonly decision: ShapingDecision;
}

const FILE_TOOL_CLASS_MAP: Readonly<Record<string, CommandClass>> = Object.freeze({
  [FileToolName.READ_FILE]: ProtocolCommandClass.FILE_READ,
  [FileToolName.WRITE_FILE]: ProtocolCommandClass.FILE_WRITE,
  [FileToolName.SEARCH_FILES]: ProtocolCommandClass.SEARCH,
  [FileToolName.LIST_DIRECTORY]: ProtocolCommandClass.NAVIGATION
});

export class OutputShapingService {
  private readonly rulesByClass = new Map<CommandClass, Readonly<OutputShapingRule>>();

  public constructor(deps: OutputShapingDependencies) {
    for (const rule of deps.rules) {
      this.rulesByClass.set(rule.command_class, rule);
    }
  }

  public classify(output: { tool_name?: string; event_type?: string }): CommandClass {
    const normalizedToolName = output.tool_name?.trim().toLowerCase();
    if (normalizedToolName !== undefined) {
      const mapped = FILE_TOOL_CLASS_MAP[normalizedToolName];
      if (mapped !== undefined) {
        return mapped;
      }

      if (normalizedToolName.includes("governance")) {
        return "governance_query";
      }

      if (looksLikeVerification(normalizedToolName)) {
        return "verification";
      }
    }

    const normalizedEventType = output.event_type?.trim().toLowerCase();
    if (normalizedEventType !== undefined) {
      if (normalizedEventType.includes("governance")) {
        return "governance_query";
      }

      if (normalizedEventType.includes("verification")) {
        return "verification";
      }
    }

    return "other";
  }

  public shape(outputs: readonly Readonly<ShapeableOutput>[]): ShapeBatchResult {
    if (outputs.length === 0) {
      return {
        shaped: Object.freeze([]),
        decisions: Object.freeze([])
      };
    }

    const shaped: ShapedBatchEntry[] = [];
    const decisions: ShapingDecision[] = [];

    for (const group of splitIntoConsecutiveGroups(outputs)) {
      const compression = this.compressGroup(group);

      if (compression === null) {
        shaped.push(...group.map((entry) => entry.content));
        continue;
      }

      shaped.push(...compression.shapedOutputs);
      decisions.push(compression.decision);
    }

    return {
      shaped: Object.freeze([...shaped]),
      decisions: Object.freeze(decisions)
    };
  }

  private compressGroup(group: readonly Readonly<ShapeableOutput>[]): CompressionResult | null {
    const first = firstShapeableOutput(group);
    const rule = this.rulesByClass.get(first.command_class);
    if (rule === undefined) {
      return null;
    }

    const threshold = Math.max(1, rule.min_consecutive);
    if (group.length < threshold) {
      return null;
    }

    const shapedOutputs = applyCompressionMode(group, rule.compression_mode);
    if (shapedOutputs.length >= group.length) {
      return null;
    }

    return {
      shapedOutputs,
      decision: {
        command_class: first.command_class,
        original_count: group.length,
        compressed_to: shapedOutputs.length,
        compression_mode: rule.compression_mode,
        original_event_ids: Object.freeze(group.map((entry) => entry.event_id))
      }
    };
  }
}

function looksLikeVerification(value: string): boolean {
  return (
    value.includes("verification") ||
    value.includes("verify") ||
    value.includes("test") ||
    value.includes("lint") ||
    value.includes("build")
  );
}

function splitIntoConsecutiveGroups(
  outputs: readonly Readonly<ShapeableOutput>[]
): ReadonlyArray<readonly Readonly<ShapeableOutput>[]> {
  const groups: Array<readonly Readonly<ShapeableOutput>[]> = [];
  let startIndex = 0;

  for (let index = 1; index <= outputs.length; index += 1) {
    const current = outputs[index];
    const previous = outputs[index - 1];

    if (current !== undefined && previous !== undefined && current.command_class === previous.command_class) {
      continue;
    }

    groups.push(outputs.slice(startIndex, index));
    startIndex = index;
  }

  return groups;
}

function applyCompressionMode(
  group: readonly Readonly<ShapeableOutput>[],
  mode: CompressionModeValue
): readonly unknown[] {
  const first = firstShapeableOutput(group);
  const last = lastShapeableOutput(group);
  switch (mode) {
    case CompressionMode.COUNT_SUMMARY:
      return [
        {
          type: "output_shaping.count_summary",
          command_class: first.command_class,
          count: group.length,
          summary: `${group.length} ${first.command_class} outputs compressed`
        }
      ];
    case CompressionMode.LAST_ONLY:
      return [last.content];
    case CompressionMode.FIRST_LAST:
      return [first.content, last.content];
  }
}

function firstShapeableOutput(group: readonly Readonly<ShapeableOutput>[]): Readonly<ShapeableOutput> {
  const first = group[0];
  if (first === undefined) {
    throw new Error("Output shaping invariant violated: empty compression group.");
  }
  return first;
}

function lastShapeableOutput(group: readonly Readonly<ShapeableOutput>[]): Readonly<ShapeableOutput> {
  const last = group[group.length - 1];
  if (last === undefined) {
    throw new Error("Output shaping invariant violated: empty compression group.");
  }
  return last;
}
