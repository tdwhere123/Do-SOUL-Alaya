import { describe, expect, it } from "vitest";
import {
  FileToolName,
  type OutputShapingRule
} from "@do-soul/alaya-protocol";
import {
  OutputShapingService,
  type OutputShapingDecision,
  type ShapeableOutput
} from "../output-shaping-service.js";

describe("OutputShapingService", () => {
  it("classifies clear tool and governance outputs into command classes", () => {
    const service = createService();

    expect(service.classify({ tool_name: FileToolName.READ_FILE })).toBe("file_read");
    expect(service.classify({ tool_name: FileToolName.WRITE_FILE })).toBe("file_write");
    expect(service.classify({ tool_name: FileToolName.LIST_DIRECTORY })).toBe("navigation");
    expect(service.classify({ tool_name: FileToolName.SEARCH_FILES })).toBe("search");
    expect(service.classify({ tool_name: "workspace.governance.lookup" })).toBe("governance_query");
    expect(service.classify({ tool_name: "verification.run" })).toBe("verification");
    expect(service.classify({ event_type: "soul.verification.completed" })).toBe("verification");
    expect(service.classify({ tool_name: FileToolName.EXEC_SHELL })).toBe("other");
  });

  it("passes outputs through unchanged when no consecutive group meets a shaping threshold", () => {
    const service = createService();
    const outputs = [
      createOutput("event-1", "file_read", { path: "a.ts" }),
      createOutput("event-2", "search", { pattern: "OutputShaping" }),
      createOutput("event-3", "file_read", { path: "b.ts" })
    ] satisfies readonly ShapeableOutput[];

    const result = service.shape(outputs);

    expect(result.shaped).toEqual(outputs.map((output) => output.content));
    expect(result.decisions).toEqual([]);
  });

  it("compresses three consecutive file reads with count_summary", () => {
    const service = createService();
    const outputs = [
      createOutput("event-1", "file_read", { path: "a.ts" }),
      createOutput("event-2", "file_read", { path: "b.ts" }),
      createOutput("event-3", "file_read", { path: "c.ts" })
    ] satisfies readonly ShapeableOutput[];

    const result = service.shape(outputs);

    expect(result.shaped).toEqual([
      {
        type: "output_shaping.count_summary",
        command_class: "file_read",
        count: 3,
        summary: "3 file_read outputs compressed"
      }
    ]);
    expect(result.decisions).toEqual([
      {
        command_class: "file_read",
        original_count: 3,
        compressed_to: 1,
        compression_mode: "count_summary",
        original_event_ids: ["event-1", "event-2", "event-3"]
      }
    ] satisfies readonly OutputShapingDecision[]);
  });

  it("supports last_only and first_last compression modes", () => {
    const service = createService({
      rules: [
        {
          command_class: "verification",
          min_consecutive: 2,
          compression_mode: "last_only"
        },
        {
          command_class: "navigation",
          min_consecutive: 3,
          compression_mode: "first_last"
        }
      ]
    });

    const lastOnly = service.shape([
      createOutput("event-1", "verification", { command: "pnpm lint" }),
      createOutput("event-2", "verification", { command: "pnpm test" }),
      createOutput("event-3", "verification", { command: "pnpm build" })
    ]);
    const firstLast = service.shape([
      createOutput("event-4", "navigation", { path: "src" }),
      createOutput("event-5", "navigation", { path: "src/core" }),
      createOutput("event-6", "navigation", { path: "src/core/output-shaping.ts" })
    ]);

    expect(lastOnly.shaped).toEqual([{ command: "pnpm build" }]);
    expect(lastOnly.decisions).toEqual([
      expect.objectContaining({
        command_class: "verification",
        original_count: 3,
        compressed_to: 1,
        compression_mode: "last_only"
      })
    ]);
    expect(firstLast.shaped).toEqual([{ path: "src" }, { path: "src/core/output-shaping.ts" }]);
    expect(firstLast.decisions).toEqual([
      expect.objectContaining({
        command_class: "navigation",
        original_count: 3,
        compressed_to: 2,
        compression_mode: "first_last"
      })
    ]);
  });

  it("compresses only qualifying groups in a mixed sequence", () => {
    const service = createService({
      rules: [
        {
          command_class: "file_read",
          min_consecutive: 3,
          compression_mode: "count_summary"
        },
        {
          command_class: "search",
          min_consecutive: 2,
          compression_mode: "last_only"
        }
      ]
    });
    const outputs = [
      createOutput("event-1", "file_read", { path: "a.ts" }),
      createOutput("event-2", "file_read", { path: "b.ts" }),
      createOutput("event-3", "file_read", { path: "c.ts" }),
      createOutput("event-4", "navigation", { path: "docs" }),
      createOutput("event-5", "search", { pattern: "OutputShapingService v1" }),
      createOutput("event-6", "search", { pattern: "OutputShapingService v2" })
    ] satisfies readonly ShapeableOutput[];

    const result = service.shape(outputs);

    expect(result.shaped).toEqual([
      {
        type: "output_shaping.count_summary",
        command_class: "file_read",
        count: 3,
        summary: "3 file_read outputs compressed"
      },
      { path: "docs" },
      { pattern: "OutputShapingService v2" }
    ]);
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.map((item) => item.original_event_ids)).toEqual([
      ["event-1", "event-2", "event-3"],
      ["event-5", "event-6"]
    ]);
  });

  it("returns the same shaping decision for the same input sequence", () => {
    const service = createService();
    const outputs = [
      createOutput("event-1", "search", { pattern: "alpha" }),
      createOutput("event-2", "search", { pattern: "beta" }),
      createOutput("event-3", "search", { pattern: "gamma" })
    ] satisfies readonly ShapeableOutput[];

    expect(service.shape(outputs)).toEqual(service.shape(outputs));
  });
});

function createService(overrides: Partial<ConstructorParameters<typeof OutputShapingService>[0]> = {}) {
  const rules =
    overrides.rules ??
    ([
      {
        command_class: "file_read",
        min_consecutive: 3,
        compression_mode: "count_summary"
      },
      {
        command_class: "search",
        min_consecutive: 3,
        compression_mode: "last_only"
      },
      {
        command_class: "navigation",
        min_consecutive: 3,
        compression_mode: "first_last"
      },
      {
        command_class: "verification",
        min_consecutive: 3,
        compression_mode: "last_only"
      },
      {
        command_class: "governance_query",
        min_consecutive: 3,
        compression_mode: "last_only"
      }
    ] satisfies readonly OutputShapingRule[]);

  return new OutputShapingService({
    rules
  });
}

function createOutput(
  eventId: string,
  commandClass: ShapeableOutput["command_class"],
  content: unknown
): ShapeableOutput {
  return {
    event_id: eventId,
    command_class: commandClass,
    content
  };
}
