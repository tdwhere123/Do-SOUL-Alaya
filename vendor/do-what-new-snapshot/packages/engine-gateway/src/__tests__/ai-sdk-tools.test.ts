import { promises as fs } from "node:fs";
import { asSchema } from "ai";
import { describe, expect, it, vi } from "vitest";
import {
  SoulApplyOverrideRequestSchema,
  SoulExploreGraphRequestSchema
} from "@do-what/protocol";
import { buildAiSdkTools, type SoulToolDef } from "../provider/ai-sdk-tools.js";

const exampleToolDef: SoulToolDef = {
  name: "soul.apply_override",
  description: "Apply an immediate session-only correction.",
  parametersSchema: SoulApplyOverrideRequestSchema
};

describe("buildAiSdkTools", () => {
  it("returns a Tool for each soul tool def", () => {
    const tools = buildAiSdkTools([
      exampleToolDef,
      {
        name: "soul.explore_graph",
        description: "Inspect one-hop memory graph neighbors.",
        parametersSchema: SoulExploreGraphRequestSchema
      }
    ]);

    expect(Object.keys(tools)).toEqual(["soul.apply_override", "soul.explore_graph"]);
    expect(tools["soul.apply_override"]).toMatchObject({
      description: "Apply an immediate session-only correction."
    });
  });

  it("derives the AI SDK input schema from the provided zod schema", async () => {
    const tools = buildAiSdkTools([exampleToolDef]);
    const jsonSchema = await asSchema(tools["soul.apply_override"].inputSchema).jsonSchema;

    expect(jsonSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        target_object: { type: "string" },
        correction: { type: "string" },
        priority: { type: "integer", minimum: 0 }
      },
      required: ["target_object", "correction"]
    });
  });

  it("returns from the execute stub without touching the filesystem", async () => {
    const readFileSpy = vi.spyOn(fs, "readFile");
    const tool = buildAiSdkTools([exampleToolDef])["soul.apply_override"];

    await tool.execute?.(
      { target_object: "memory-1", correction: "Prefer pnpm", priority: 2 },
      { toolCallId: "toolu_fs", messages: [] }
    );

    expect(readFileSpy).not.toHaveBeenCalled();
    readFileSpy.mockRestore();
  });

  it("returns from the execute stub without making network calls", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const tool = buildAiSdkTools([exampleToolDef])["soul.apply_override"];

    await tool.execute?.(
      { target_object: "memory-1", correction: "Prefer pnpm", priority: 2 },
      { toolCallId: "toolu_net", messages: [] }
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("returns the original toolCallId and args from the execute stub", async () => {
    const tool = buildAiSdkTools([exampleToolDef])["soul.apply_override"];

    await expect(
      tool.execute?.(
        { target_object: "memory-1", correction: "Prefer pnpm", priority: 2 },
        { toolCallId: "toolu_result", messages: [] }
      )
    ).resolves.toEqual({
      __stub: true,
      toolCallId: "toolu_result",
      args: { target_object: "memory-1", correction: "Prefer pnpm", priority: 2 }
    });
  });

  it("returns an empty Record when no defs are provided", () => {
    expect(buildAiSdkTools([])).toEqual({});
  });
});
