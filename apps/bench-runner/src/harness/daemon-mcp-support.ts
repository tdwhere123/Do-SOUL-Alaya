import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type AlayaDaemonRuntime } from "@do-soul/alaya";
import { createAlayaCliBridge } from "@do-soul/alaya/cli/bridge";
import { registerAlayaCliCommands } from "@do-soul/alaya/cli/register";

export function makeDispatchCli(
  runtime: AlayaDaemonRuntime
): (argv: readonly string[]) => Promise<{ exitCode: number; json?: unknown }> {
  return async (argv) => {
    const bridge = createAlayaCliBridge(runtime, {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      isTTY: false
    });
    registerAlayaCliCommands(bridge, runtime);
    return bridge.dispatch(argv);
  };
}

export async function callMcpTool<TOutput>(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<TOutput> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError === true) {
    const contentArray = Array.isArray(result.content)
      ? (result.content as readonly unknown[])
      : [];
    const errorText = contentArray
      .map((item) =>
        item !== null &&
        typeof item === "object" &&
        "text" in item &&
        typeof (item as { text: unknown }).text === "string"
          ? (item as { text: string }).text
          : ""
      )
      .join("\n");
    throw new Error(`MCP tool ${name} failed: ${errorText}`);
  }
  const structured = result.structuredContent as
    | Readonly<{ ok: true; output: TOutput }>
    | undefined;
  if (structured?.ok !== true) {
    throw new Error(`MCP tool ${name} returned non-ok structured content`);
  }
  return structured.output;
}

export function benchSessionSurfacesEnabled(): boolean {
  const raw = process.env.ALAYA_BENCH_SESSION_SURFACES?.trim().toLowerCase();
  if (raw === undefined || raw === "") {
    return true;
  }
  return !(raw === "0" || raw === "false" || raw === "off" || raw === "no");
}

