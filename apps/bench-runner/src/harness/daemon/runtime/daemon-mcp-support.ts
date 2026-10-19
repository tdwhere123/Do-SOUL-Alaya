import { PassThrough } from "node:stream";
import { parseDefaultOnFlag } from "@do-soul/alaya-protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { type AlayaDaemonRuntime } from "@do-soul/alaya";
import { createAlayaCliBridge } from "@do-soul/alaya/cli/bridge";
import { registerAlayaCliCommands } from "@do-soul/alaya/cli/register";

export function makeDispatchCli(
  runtime: AlayaDaemonRuntime
): (argv: readonly string[]) => Promise<{ exitCode: number; json?: unknown }> {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // Unread PassThrough hits highWaterMark and would stall later reused dispatches.
  stdout.resume();
  stderr.resume();
  const bridge = createAlayaCliBridge(runtime, {
    stdin: new PassThrough(),
    stdout,
    stderr,
    isTTY: false
  });
  registerAlayaCliCommands(bridge, runtime);
  return async (argv) => bridge.dispatch(argv);
}

export type BenchMcpToolCapture = Readonly<{
  request: Readonly<{ name: string; arguments: Record<string, unknown> }>;
  /** The received MCP envelope, including the original emitted text. */
  response: unknown;
}>;

export async function callMcpTool<TOutput>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  capture?: (frame: BenchMcpToolCapture) => void
): Promise<TOutput> {
  const request = capture === undefined ? { name, arguments: args } : structuredClone({ name, arguments: args });
  const capturedRequest = capture === undefined ? undefined : structuredClone(request);
  const result = await client.callTool(request);
  // Retain failed native responses too. A required archive write failure aborts the
  // benchmark; independent copies keep capture code from changing admitted output.
  if (capture !== undefined) capture({ request: capturedRequest!, response: structuredClone(result) });
  return readBenchMcpToolOutput<TOutput>(name, result);
}

/** Runtime calls and frozen capture readers share the same MCP success/error admission. */
export function readBenchMcpToolOutput<TOutput>(name: string, value: unknown): TOutput {
  const result = value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
  if (result?.isError === true) {
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
  const structured = result?.structuredContent as
    | Readonly<{ ok: true; output: TOutput }>
    | undefined;
  if (structured?.ok !== true) {
    throw new Error(`MCP tool ${name} returned non-ok structured content`);
  }
  return structured.output;
}

export function benchSessionSurfacesEnabled(): boolean {
  return parseDefaultOnFlag(
    process.env.ALAYA_BENCH_SESSION_SURFACES,
    "ALAYA_BENCH_SESSION_SURFACES"
  );
}

