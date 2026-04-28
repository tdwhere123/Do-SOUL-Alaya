import type { Hono } from "hono";
import {
  SlashCommandDescriptorSchema,
  SlashCommandListResultSchema,
  SlashCommandDispatchRequestSchema,
  SlashCommandDispatchResultSchema,
  type SlashCommandDescriptor
} from "@do-what/protocol";
import { parseJsonBody } from "./shared.js";

const SLASH_UNAVAILABLE_REASON =
  "Claude CLI-only command; no supported do-what non-interactive slash dispatch contract is wired.";

export interface SlashCommandRouteService {
  listCommands(input?: { readonly runId?: string }): Promise<{
    readonly commands: readonly SlashCommandDescriptor[];
  }>;
  dispatchCommand(input: {
    readonly name: string;
    readonly runId: string;
  }): Promise<{
    readonly name: string;
    readonly status: "dispatched" | "unavailable" | "failed";
    readonly message: string;
  }>;
}

export const SLASH_COMMAND_DESCRIPTORS: readonly SlashCommandDescriptor[] = Object.freeze([
  {
    name: "/cost",
    description: "Show Claude Code session cost",
    available: false,
    dispatchable: false,
    unavailable_reason: SLASH_UNAVAILABLE_REASON
  },
  {
    name: "/help",
    description: "Show Claude Code interactive help",
    available: false,
    dispatchable: false,
    unavailable_reason: SLASH_UNAVAILABLE_REASON
  },
  {
    name: "/model",
    description: "Change the active Claude model",
    available: false,
    dispatchable: false,
    unavailable_reason: SLASH_UNAVAILABLE_REASON
  },
  {
    name: "/permissions",
    description: "Open Claude Code permission controls",
    available: false,
    dispatchable: false,
    unavailable_reason: SLASH_UNAVAILABLE_REASON
  }
].map((descriptor) => SlashCommandDescriptorSchema.parse(descriptor)));

export function registerSlashCommandRoutes(app: Hono, service?: SlashCommandRouteService): void {
  app.get("/slash-commands", async (context) => {
    const runId = context.req.query("run_id")?.trim();

    if (service !== undefined) {
      const result = await service.listCommands(runId !== undefined && runId.length > 0 ? { runId } : {});
      return context.json(
        {
          success: true,
          data: SlashCommandListResultSchema.parse(result)
        },
        200
      );
    }

    return context.json(
      {
        success: true,
        data: SlashCommandListResultSchema.parse({
          commands: SLASH_COMMAND_DESCRIPTORS
        })
      },
      200
    );
  });

  app.post("/slash-commands/:name/dispatch", async (context) => {
    const name = context.req.param("name");
    const request = SlashCommandDispatchRequestSchema.parse(
      await parseJsonBody(context.req.json.bind(context.req))
    );

    if (service !== undefined) {
      const result = await service.dispatchCommand({
        name,
        runId: request.run_id
      });

      return context.json(
        {
          success: true,
          data: SlashCommandDispatchResultSchema.parse(result)
        },
        200
      );
    }

    const descriptor = SLASH_COMMAND_DESCRIPTORS.find((command) => command.name === name);
    const reason = descriptor?.unavailable_reason ?? "Slash command is not allowlisted.";

    return context.json(
      {
        success: true,
        data: SlashCommandDispatchResultSchema.parse({
          name,
          status: "unavailable",
          message: `Slash command ${name} is unavailable: ${reason}`
        })
      },
      200
    );
  });
}
