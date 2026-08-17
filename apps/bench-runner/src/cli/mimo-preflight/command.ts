import process from "node:process";
import { probeMimoProtocol } from "../../longmemeval/mimo/protocol-probe.js";
import { proveMimoZeroCallReplay } from "../../longmemeval/mimo/replay-proof.js";
import { retireObsoleteDeepseekCache } from "../../longmemeval/mimo/retire-deepseek-cache.js";
import { parseDiagnosticLoopArgs } from "../diagnostic-loop/args.js";

export async function runMimoPreflightCommand(
  args: ReadonlyArray<string>
): Promise<number> {
  try {
    const mode = readMode(args);
    if (mode === "probe" || mode === "probe-sse") {
      return await runProbe(args, mode === "probe-sse" ? "sse" : "json");
    }
    if (mode === "replay") {
      const parsed = parseDiagnosticLoopArgs(withoutMode(args));
      const proof = proveMimoZeroCallReplay({ request: parsed.request });
      process.stdout.write(
        `Done. mimo-preflight replay physical_calls=${proof.physical_calls} ` +
        `profile=${proof.profile}\n`
      );
      return 0;
    }
    const cacheRoot = required(args, "--extraction-cache-root");
    const expected = required(args, "--expected-path");
    const result = retireObsoleteDeepseekCache({
      cacheRoot,
      expectedPath: expected,
      confirm: args.includes("--confirm-retire")
    });
    process.stdout.write(`Done. mimo-preflight retire ${result.reason}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner mimo-preflight: ${
        error instanceof Error ? error.message : String(error)
      }\n`
    );
    return 2;
  }
}

async function runProbe(
  args: ReadonlyArray<string>,
  framing: "json" | "sse"
): Promise<number> {
  const apiKey = process.env.OFFICIAL_API_GARDEN_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    throw new Error("probe mode requires OFFICIAL_API_GARDEN_API_KEY; use replay for cache-only");
  }
  const receipt = await probeMimoProtocol({
    providerUrl: required(args, "--provider-route"),
    apiKey,
    framing,
    fetchImpl: fetch
  });
  process.stdout.write(
    `Done. mimo-preflight probe framing=${receipt.framing} ` +
    `physical_calls=${receipt.physical_calls} ` +
    `usage=${receipt.usage_present} finish=${receipt.finish_reason ?? "none"}\n`
  );
  return 0;
}

function readMode(
  args: ReadonlyArray<string>
): "probe" | "probe-sse" | "replay" | "retire-deepseek" {
  const index = args.findIndex((token) => token === "--mode" || token.startsWith("--mode="));
  const value = index < 0
    ? "replay"
    : args[index]!.startsWith("--mode=")
      ? args[index]!.slice("--mode=".length)
      : args[index + 1];
  if (
    value === "probe" || value === "probe-sse" ||
    value === "replay" || value === "retire-deepseek"
  ) {
    return value;
  }
  throw new Error(
    "mimo-preflight --mode must be probe, probe-sse, replay, or retire-deepseek"
  );
}

function withoutMode(args: ReadonlyArray<string>): readonly string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (token === "--mode") {
      index += 1;
      continue;
    }
    if (token.startsWith("--mode=")) continue;
    stripped.push(token);
  }
  return stripped;
}

function required(args: ReadonlyArray<string>, flag: string): string {
  const index = args.findIndex((token) => token === flag || token.startsWith(`${flag}=`));
  if (index < 0) throw new Error(`${flag} is required`);
  const token = args[index]!;
  const value = token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : args[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}
