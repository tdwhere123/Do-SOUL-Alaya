import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requireProviderBinding,
  resolveVendorModel
} from "../../runs/provider/catalog.js";
import { probeProviderProtocol } from "../../runs/provider/protocol-probe.js";
import { proveProviderZeroCallReplay } from "../../runs/provider/replay-proof.js";
import { resolveDiagnosticLoopIdentity } from
  "../../runs/diagnostic-loop/authority/identity.js";
import { verifyProviderPreflightReplayReceiptBinding } from
  "../../runs/provider/replay-receipt.js";
import { retireObsoleteCache } from "../../runs/provider/retire-obsolete-cache.js";
import { readCheckpoint } from "../../runs/diagnostic-loop/checkpoint.js";
import {
  verifyCanonicalReplayRequestManifest
} from "./replay-request-manifest.js";
import { assertCacheOnlyEnvironment } from
  "../../runs/snapshot/current/current-substrate-authority.js";

export async function runProviderPreflightCommand(
  args: ReadonlyArray<string>
): Promise<number> {
  try {
    const mode = readMode(args);
    if (mode === "probe" || mode === "probe-sse") {
      return await runProbe(args, mode === "probe-sse" ? "sse" : "json");
    }
    if (mode === "replay") {
      return await runReplay(args);
    }
    if (mode === "validate-replay-receipt") {
      await validateReplayReceipt(args);
      return 0;
    }
    if (mode === "validate-recall-checkpoints") {
      validateRecallCheckpoints(required(args, "--work-root"));
      process.stdout.write("Done. recall checkpoint guard validated\n");
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

async function runReplay(args: ReadonlyArray<string>): Promise<0> {
  const requestManifest = required(args, "--request-manifest");
  assertCacheOnlyEnvironment(process.env);
  const verifiedManifest = await verifyCanonicalReplayRequestManifest(requestManifest);
  const request = verifiedManifest.request;
  const identity = await resolveDiagnosticLoopIdentity(request);
  const proof = await proveProviderZeroCallReplay({
    request,
    ...(identity.query_factor_cache === undefined
      ? {}
      : { expectedFileSha256: identity.query_factor_cache.file_sha256 })
  });
  const receipt = verifyProviderPreflightReplayReceiptBinding({
    schema_version: 2,
    kind: "provider_preflight_replay_receipt",
    provider_port: "absent",
    physical_calls: proof.physical_calls,
    model: request.model,
    profile: proof.profile,
    key_count: request.requestedKeys.length,
    request_manifest_sha256: verifiedManifest.request_manifest_sha256,
    cache_manifest_sha256: verifiedManifest.cache_authority.manifest_sha256,
    evidence_prompt_sha256: proof.evidence_prompt_sha256,
    query_prompt_sha256: proof.query_prompt_sha256,
    evidence_request_template_sha256: proof.evidence_request_template_sha256,
    query_request_template_sha256: proof.query_request_template_sha256
  }, verifiedManifest);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return 0;
}

async function validateReplayReceipt(args: ReadonlyArray<string>): Promise<void> {
  const manifest = await verifyCanonicalReplayRequestManifest(
    required(args, "--request-manifest")
  );
  const receipt = JSON.parse(readFileSync(required(args, "--receipt"), "utf8")) as unknown;
  verifyProviderPreflightReplayReceiptBinding(receipt, manifest);
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
): "probe" | "probe-sse" | "replay" | "retire-obsolete" |
  "validate-recall-checkpoints" | "validate-replay-receipt" {
  const index = args.findIndex((token) => token === "--mode" || token.startsWith("--mode="));
  const value = index < 0
    ? "replay"
    : args[index]!.startsWith("--mode=")
      ? args[index]!.slice("--mode=".length)
      : args[index + 1];
  if (
    value === "probe" || value === "probe-sse" ||
    value === "replay" || value === "retire-obsolete" ||
    value === "validate-recall-checkpoints" || value === "validate-replay-receipt"
  ) {
    return value;
  }
  throw new Error(
    "provider-preflight --mode must be probe, probe-sse, replay, " +
      "retire-obsolete, validate-recall-checkpoints, or validate-replay-receipt"
  );
}

function validateRecallCheckpoints(workRoot: string): void {
  for (const phase of ["control_recall", "treatment_recall"] as const) {
    const path = join(workRoot, "checkpoints", `${phase}.json`);
    if (!existsSync(path)) continue;
    const checkpoint = readRecallCheckpoint(path, phase);
    if (checkpoint.phase !== phase) {
      throw new Error(`recall checkpoint phase mismatch at ${phase}`);
    }
    if (checkpoint.status === "completed") {
      throw new Error(`completed recall checkpoint under ${workRoot}`);
    }
  }
}

function readRecallCheckpoint(
  path: string,
  phase: "control_recall" | "treatment_recall"
): ReturnType<typeof readCheckpoint> {
  try {
    return readCheckpoint(path);
  } catch (error) {
    throw new Error(
      `invalid recall checkpoint at ${phase}: ${
        error instanceof Error ? error.message : String(error)}`
    );
  }
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
