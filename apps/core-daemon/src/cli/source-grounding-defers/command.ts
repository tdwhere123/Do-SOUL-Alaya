import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { SignalService } from "@do-soul/alaya-core";
import {
  BoundedJsonObjectSchema,
  IsoDatetimeStringSchema,
  type CandidateMemorySignal
} from "@do-soul/alaya-protocol";
import {
  ALAYA_SYSEXITS,
  type AlayaCliArgsSchema,
  type AlayaCliContext,
  type AlayaCliResult,
  type AlayaSubcommandSpec
} from "../bridge.js";
import {
  projectSourceGroundingDeferEntry,
  projectSourceGroundingDeferStats
} from "./projection.js";

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 10_000;
const MAX_RAW_PAYLOAD_FILE_BYTES = 65_536;

type SourceGroundingDeferService = Pick<
  SignalService,
  | "getSourceGroundingDeferStats"
  | "listSourceGroundingDefers"
  | "redriveSourceGroundingDefer"
  | "reconcileStaleSourceGroundingRedrive"
>;

export interface SourceGroundingDefersCommandDependencies {
  readonly signalService: SourceGroundingDeferService;
}

interface SourceGroundingDefersArgs {
  readonly action: "list" | "redrive" | "reconcile";
  readonly workspaceId: string;
  readonly signalId: string | null;
  readonly limit: number;
  readonly expectedClaimFingerprint: string | null;
  readonly expectedClaimExpiresAt: string | null;
  readonly reason: string | null;
  readonly rawPayloadFile: string | null;
}

interface ParsedOptions {
  workspaceId: string | null;
  signalId: string | null;
  limit: number;
  limitProvided: boolean;
  expectedClaimFingerprint: string | null;
  expectedClaimExpiresAt: string | null;
  reason: string | null;
  rawPayloadFile: string | null;
}

type ParseResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; message: string }>;

export function createSourceGroundingDefersCommand(
  deps: SourceGroundingDefersCommandDependencies
): AlayaSubcommandSpec<SourceGroundingDefersArgs> {
  return {
    name: "source-grounding-defers",
    description: "List, re-drive, or reconcile source-grounding defer obligations.",
    argsSchema: sourceGroundingDefersArgsSchema(),
    requiresDaemonReady: true,
    handler: async (ctx, args) => await executeSourceGroundingDefers(ctx, args, deps)
  };
}

async function executeSourceGroundingDefers(
  ctx: AlayaCliContext,
  args: SourceGroundingDefersArgs,
  deps: SourceGroundingDefersCommandDependencies
): Promise<AlayaCliResult> {
  if (args.action === "list") return executeList(ctx, args, deps.signalService);
  if (args.action === "redrive") return await executeRedrive(ctx, args, deps.signalService);
  return await executeReconcile(ctx, args, deps.signalService);
}

function executeList(
  ctx: AlayaCliContext,
  args: SourceGroundingDefersArgs,
  service: SourceGroundingDeferService
): AlayaCliResult {
  const entries = service.listSourceGroundingDefers(args.workspaceId, args.limit)
    .map(projectSourceGroundingDeferEntry);
  const stats = projectSourceGroundingDeferStats(
    service.getSourceGroundingDeferStats(args.workspaceId)
  );
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(
      `workspace=${args.workspaceId} queue_total=${stats.queue_depth} cap_per_workspace=${stats.queue_cap_per_workspace} hard_limit_per_workspace=${stats.queue_hard_limit_per_workspace} blocked=${stats.capacity_blocked_depth} capacity=${stats.capacity_state} returned=${entries.length}\n`
    );
    for (const entry of entries) {
      ctx.stdout.write(
        `${entry.signal_id}\treason=${entry.defer_reason}\tadmission=${entry.admission_state}\tclaim_fingerprint=${entry.claim_token_fingerprint ?? "none"}\texpires=${entry.claim_expires_at ?? "n/a"}\n`
      );
    }
  }
  return {
    exitCode: ALAYA_SYSEXITS.OK,
    json: { action: "list", workspace_id: args.workspaceId, stats, entries }
  };
}

async function executeRedrive(
  ctx: AlayaCliContext,
  args: SourceGroundingDefersArgs,
  service: SourceGroundingDeferService
): Promise<AlayaCliResult> {
  const signalId = args.signalId!;
  const rawPayload = await readRawPayloadFile(ctx.cwd, args.rawPayloadFile);
  const result = await service.redriveSourceGroundingDefer(
    args.workspaceId,
    signalId,
    rawPayload === null ? undefined : { raw_payload: rawPayload }
  );
  const report = {
    action: "redrive",
    workspace_id: args.workspaceId,
    signal_id: signalId,
    signal_state: result.signal.signal_state,
    triage_result: result.triage_result,
    materialization_target: result.materialization?.target_kind ?? null
  } as const;
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(
      `redrive ${signalId}: state=${report.signal_state} triage=${report.triage_result} target=${report.materialization_target ?? "none"}\n`
    );
  }
  return { exitCode: ALAYA_SYSEXITS.OK, json: report };
}

async function executeReconcile(
  ctx: AlayaCliContext,
  args: SourceGroundingDefersArgs,
  service: SourceGroundingDeferService
): Promise<AlayaCliResult> {
  const signalId = args.signalId!;
  const signal = await service.reconcileStaleSourceGroundingRedrive({
    workspaceId: args.workspaceId,
    signalId,
    claimTokenFingerprint: args.expectedClaimFingerprint!,
    expectedClaimExpiresAt: args.expectedClaimExpiresAt!,
    reason: args.reason!
  });
  const report = {
    action: "reconcile",
    workspace_id: args.workspaceId,
    signal_id: signalId,
    expected_claim_expires_at: args.expectedClaimExpiresAt,
    signal_state: signal.signal_state
  } as const;
  if (ctx.jsonRequested !== true) {
    ctx.stdout.write(`reconciled ${signalId}: state=${signal.signal_state}\n`);
  }
  return { exitCode: ALAYA_SYSEXITS.OK, json: report };
}

function sourceGroundingDefersArgsSchema(): AlayaCliArgsSchema<SourceGroundingDefersArgs> {
  return {
    safeParse(input) {
      if (!Array.isArray(input) || input.some((token) => typeof token !== "string")) {
        return cliArgsError("Expected a string argument list.");
      }
      const parsed = parseArgs(input);
      return parsed.ok ? { success: true, data: parsed.value } : cliArgsError(parsed.message);
    }
  };
}

function parseArgs(input: readonly string[]): ParseResult<SourceGroundingDefersArgs> {
  const action = input[0];
  if (action !== "list" && action !== "redrive" && action !== "reconcile") {
    return { ok: false, message: commandUsage() };
  }
  const parsed = parseOptions(input.slice(1));
  if (!parsed.ok) return parsed;
  if (parsed.value.workspaceId === null) {
    return { ok: false, message: "--workspace is required." };
  }
  return validateAction(action, parsed.value);
}

function parseOptions(input: readonly string[]): ParseResult<ParsedOptions> {
  const options: ParsedOptions = {
    workspaceId: null,
    signalId: null,
    limit: DEFAULT_LIST_LIMIT,
    limitProvided: false,
    expectedClaimFingerprint: null,
    expectedClaimExpiresAt: null,
    reason: null,
    rawPayloadFile: null
  };
  for (let index = 0; index < input.length; index += 2) {
    const flag = input[index]!;
    const value = input[index + 1];
    if (value === undefined || value.trim().length === 0) {
      return { ok: false, message: `${flag} requires a non-empty value.` };
    }
    const assigned = assignOption(options, flag, value);
    if (!assigned.ok) return assigned;
  }
  return { ok: true, value: options };
}

function assignOption(options: ParsedOptions, flag: string, value: string): ParseResult<true> {
  if (flag === "--workspace") options.workspaceId = value;
  else if (flag === "--signal") options.signalId = value;
  else if (flag === "--expected-claim-fingerprint") options.expectedClaimFingerprint = value;
  else if (flag === "--expected-claim-expires-at") options.expectedClaimExpiresAt = value;
  else if (flag === "--reason") options.reason = value;
  else if (flag === "--limit") return assignLimit(options, value);
  else if (flag === "--raw-payload-file") options.rawPayloadFile = value;
  else return { ok: false, message: `Unknown option: ${flag}` };
  return { ok: true, value: true };
}

function assignLimit(options: ParsedOptions, value: string): ParseResult<true> {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    return { ok: false, message: `--limit must be an integer from 1 to ${MAX_LIST_LIMIT}.` };
  }
  options.limit = limit;
  options.limitProvided = true;
  return { ok: true, value: true };
}

async function readRawPayloadFile(
  cwd: string,
  filePath: string | null
): Promise<CandidateMemorySignal["raw_payload"] | null> {
  if (filePath === null) return null;
  try {
    const resolved = path.resolve(cwd, filePath);
    if ((await stat(resolved)).size > MAX_RAW_PAYLOAD_FILE_BYTES) {
      throw new Error("Raw-payload patch file exceeds the 64 KiB input limit.");
    }
    const content = await readFile(resolved, "utf8");
    const parsed = BoundedJsonObjectSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      throw new Error("Raw-payload patch file must contain a bounded JSON object.");
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Raw-payload")) throw error;
    throw new Error(`Failed to read raw-payload patch file: ${filePath}`, { cause: error });
  }
}

function validateAction(
  action: SourceGroundingDefersArgs["action"],
  options: ParsedOptions
): ParseResult<SourceGroundingDefersArgs> {
  if (action === "list" && hasMutationOptions(options)) {
    return { ok: false, message: "list accepts only --workspace and --limit." };
  }
  if (action !== "list" && options.signalId === null) {
    return { ok: false, message: `--signal is required for ${action}.` };
  }
  if (action !== "list" && options.limitProvided) {
    return { ok: false, message: `${action} does not accept --limit.` };
  }
  if (action === "redrive" && hasReconciliationOptions(options)) {
    return { ok: false, message: "redrive does not accept reconciliation options." };
  }
  const reconcileError = validateReconciliationOptions(action, options);
  if (reconcileError !== null) return { ok: false, message: reconcileError };
  if (action === "reconcile" && options.rawPayloadFile !== null) {
    return { ok: false, message: "reconcile does not accept --raw-payload-file." };
  }
  return {
    ok: true,
    value: {
      action,
      workspaceId: options.workspaceId!,
      signalId: options.signalId,
      limit: options.limit,
      expectedClaimFingerprint: options.expectedClaimFingerprint,
      expectedClaimExpiresAt: options.expectedClaimExpiresAt,
      reason: options.reason,
      rawPayloadFile: options.rawPayloadFile
    }
  };
}

function validateReconciliationOptions(
  action: SourceGroundingDefersArgs["action"],
  options: ParsedOptions
): string | null {
  if (action !== "reconcile") return null;
  if (!hasCompleteReconciliationOptions(options)) {
    return "reconcile requires --expected-claim-fingerprint, --expected-claim-expires-at, and --reason.";
  }
  if (!IsoDatetimeStringSchema.safeParse(options.expectedClaimExpiresAt).success) {
    return "--expected-claim-expires-at must be an ISO datetime.";
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.expectedClaimFingerprint ?? "")) {
    return "--expected-claim-fingerprint must be a SHA-256 fingerprint.";
  }
  return null;
}

function hasMutationOptions(options: ParsedOptions): boolean {
  return options.signalId !== null || options.expectedClaimFingerprint !== null ||
    options.expectedClaimExpiresAt !== null || options.reason !== null ||
    options.rawPayloadFile !== null;
}

function hasReconciliationOptions(options: ParsedOptions): boolean {
  return options.expectedClaimFingerprint !== null || options.expectedClaimExpiresAt !== null ||
    options.reason !== null;
}

function hasCompleteReconciliationOptions(options: ParsedOptions): boolean {
  return options.expectedClaimFingerprint !== null && options.expectedClaimExpiresAt !== null &&
    options.reason !== null;
}

function cliArgsError(message: string) {
  return { success: false as const, error: { issues: [{ path: [], message }] } };
}

function commandUsage(): string {
  return "Usage: source-grounding-defers list|redrive|reconcile --workspace <id> [options]";
}
