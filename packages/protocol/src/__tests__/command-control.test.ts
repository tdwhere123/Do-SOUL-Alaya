import { describe, expect, it } from "vitest";
import {
  RunInterruptResultSchema,
  SlashCommandDescriptorSchema,
  SlashCommandDispatchResultSchema
} from "../command-control.js";

describe("command control protocol", () => {
  it("accepts the frozen run interrupt result statuses", () => {
    const statuses = ["cancelled", "already_finished", "no_active", "unsupported", "failed"] as const;

    for (const status of statuses) {
      expect(
        RunInterruptResultSchema.parse({
          run_id: "run-1",
          status,
          message: `${status} message`
        })
      ).toMatchObject({ run_id: "run-1", status });
    }
  });

  it("requires slash descriptors to expose availability and dispatchability separately", () => {
    expect(
      SlashCommandDescriptorSchema.parse({
        name: "/cost",
        description: "Show Claude Code session cost",
        available: false,
        dispatchable: false,
        unavailable_reason: "raw CLI-only command"
      })
    ).toEqual({
      name: "/cost",
      description: "Show Claude Code session cost",
      available: false,
      dispatchable: false,
      unavailable_reason: "raw CLI-only command"
    });

    expect(() =>
      SlashCommandDescriptorSchema.parse({
        name: "/cost",
        description: "Show Claude Code session cost",
        available: false,
        dispatchable: false
      })
    ).toThrow();

    expect(() =>
      SlashCommandDescriptorSchema.parse({
        name: "/cost",
        description: "Show Claude Code session cost",
        available: true,
        dispatchable: false
      })
    ).toThrow();
  });

  it("represents unavailable slash dispatch explicitly", () => {
    expect(
      SlashCommandDispatchResultSchema.parse({
        name: "/cost",
        status: "unavailable",
        message: "Slash command /cost is unavailable: raw CLI-only command"
      })
    ).toMatchObject({
      name: "/cost",
      status: "unavailable"
    });
  });
});
