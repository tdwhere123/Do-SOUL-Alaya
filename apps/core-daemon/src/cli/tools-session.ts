import { AlayaError } from "@do-soul/alaya-protocol";
import { Readable } from "node:stream";
import { ALAYA_SYSEXITS, type AlayaCliContext, type AlayaCliResult } from "./bridge.js";

const MAX_LINE_BYTES = 1_048_576;
const MAX_CALLS = 256;
const SESSION_LIFETIME_MS = 300_000;

/** Surface invariant 22: one explicit CLI process retains the same runtime and principal.
 * EOF, capacity or lifetime closes the session; launcher finally shuts down its worker owner.
 */
export async function runToolsSession(ctx: AlayaCliContext,
  call: (tool: string, input: unknown, signal: AbortSignal) => Promise<AlayaCliResult>): Promise<AlayaCliResult> {
  const input = ctx.stdin as Readable;
  let expired = false, calls = 0;
  let pending = Buffer.alloc(0);
  const controller = new AbortController();
  const timer = setTimeout(() => { expired = true; controller.abort(); input.destroy(); }, SESSION_LIFETIME_MS);
  timer.unref();
  const consume = async (line: Buffer) => {
    if (expired || ++calls > MAX_CALLS) throw new AlayaError("VALIDATION", "tools session capacity or lifetime exhausted");
    const request: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
    if (typeof request !== "object" || request === null || !("tool" in request) ||
        typeof request.tool !== "string" || !request.tool.trim() ||
        Object.keys(request).some(key => key !== "tool" && key !== "arguments")) {
      throw new AlayaError("VALIDATION", "tools session expects {tool, arguments} JSON lines");
    }
    const result = await call(request.tool, "arguments" in request ? request.arguments : {}, controller.signal);
    if (expired) throw new AlayaError("VALIDATION", "tools session lifetime exhausted");
    ctx.stdout.write(`${JSON.stringify({ exitCode: result.exitCode, output: result.json ?? null })}\n`);
  };
  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      for (let end = 0; end <= bytes.length; end++) {
        if (end !== bytes.length && bytes[end] !== 10) continue;
        const part = bytes.subarray(start, end);
        if (pending.length + part.length > MAX_LINE_BYTES) throw new AlayaError("VALIDATION", "tools session line exceeds 1 MiB");
        pending = Buffer.concat([pending, part]);
        if (end < bytes.length) { await consume(pending); pending = Buffer.alloc(0); }
        start = end + 1;
      }
    }
    if (expired) throw new AlayaError("VALIDATION", "tools session lifetime exhausted");
    if (pending.length > 0) await consume(pending);
    return { exitCode: ALAYA_SYSEXITS.OK };
  } catch (error) {
    ctx.stderr.write(`${error instanceof Error ? error.message : "tools session failed"}\n`);
    return { exitCode: ALAYA_SYSEXITS.DATAERR };
  } finally {
    clearTimeout(timer);
    controller.abort();
    pending = Buffer.alloc(0);
    input.pause();
  }
}
