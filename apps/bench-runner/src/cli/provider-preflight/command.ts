import process from "node:process";
import { parseDiagnosticLoopArgs } from "../diagnostic-loop/args.js";
import {
  requireProviderBinding,
  resolveVendorModel
} from "../../bench/provider/catalog.js";
import { probeProviderProtocol } from "../../bench/provider/protocol-probe.js";
import { proveProviderZeroCallReplay } from "../../bench/provider/replay-proof.js";
import { retireObsoleteCache } from "../../bench/provider/retire-obsolete-cache.js";

export async function runProviderPreflightCommand(
  args: ReadonlyArray<string>
): Promise<number> {
  try {
    const mode = readMode(args);
    if (mode === "probe" || mode === "probe-sse") {
      return await runProbe(args, mode === "probe-sse" ? "sse" : "json");
    }
    if (mode === "replay") {
      const parsed = parseDiagnosticLoopArgs(withoutMode(args));
      const proof = proveProviderZeroCallReplay({ request: parsed.request });
      process.stdout.write(
        `Done. provider-preflight replay physical_calls=${proof.physical_calls} ` +
        `profile=${proof.profile}\n`
      );
      return 0;
    }
    const cacheRoot = required(args, "--extraction-cache-root");
    const expected = required(args, "--expected-path");
    const profile = required(args, "--profile");
    const result = retireObsoleteCache({
      cacheRoot,
      expectedPath: expected,
      profile,
      confirm: args.includes("--confirm-retire")
    });
    process.stdout.write(`Done. provider-preflight retire ${result.reason}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `alaya-bench-runner provider-preflight: ${
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
    throw new Error(
      "probe mode requires OFFICIAL_API_GARDEN_API_KEY; use replay for cache-only"
    );
  }
  const model = resolveProbeModel(args);
  requireProviderBinding(model);
  const receipt = await probeProviderProtocol({
    providerUrl: required(args, "--provider-route"),
    apiKey,
    model,
    framing,
    fetchImpl: fetch
  });
  process.stdout.write(
    `Done. provider-preflight probe framing=${receipt.framing} ` +
    `model=${receipt.model} profile=${receipt.profile} ` +
    `physical_calls=${receipt.physical_calls} ` +
    `usage=${receipt.usage_present} finish=${receipt.finish_reason ?? "none"}\n`
  );
  return 0;
}

function resolveProbeModel(args: ReadonlyArray<string>): string {
  const flagged = optional(args, "--model");
  if (flagged !== undefined) return resolveVendorModel(flagged);
  const fromEnv = process.env.OFFICIAL_API_GARDEN_MODEL?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return resolveVendorModel(fromEnv);
  }
  throw new Error("probe mode requires --model or OFFICIAL_API_GARDEN_MODEL");
}

function readMode(
  args: ReadonlyArray<string>
): "probe" | "probe-sse" | "replay" | "retire-obsolete" {
  const index = args.findIndex((token) => token === "--mode" || token.startsWith("--mode="));
  const value = index < 0
    ? "replay"
    : args[index]!.startsWith("--mode=")
      ? args[index]!.slice("--mode=".length)
      : args[index + 1];
  if (
    value === "probe" || value === "probe-sse" ||
    value === "replay" || value === "retire-obsolete"
  ) {
    return value;
  }
  throw new Error(
    "provider-preflight --mode must be probe, probe-sse, replay, or retire-obsolete"
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
  const value = optional(args, flag);
  if (value === undefined) throw new Error(`${flag} is required`);
  return value;
}

function optional(args: ReadonlyArray<string>, flag: string): string | undefined {
  const index = args.findIndex((token) => token === flag || token.startsWith(`${flag}=`));
  if (index < 0) return undefined;
  const token = args[index]!;
  const value = token.startsWith(`${flag}=`) ? token.slice(flag.length + 1) : args[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`${flag} requires a value`);
  return value;
}
