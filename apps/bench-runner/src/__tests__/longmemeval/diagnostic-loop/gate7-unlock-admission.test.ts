import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRecordDigest, runRecordPath } from
  "../../../bench/diagnostic-loop/run-state.js";
import { resolvedDiagnosticLoopIdentityDigest, resolveDiagnosticLoopIdentity } from
  "../../../bench/diagnostic-loop/authority/identity.js";
import { checkpointDigest } from "../../../bench/diagnostic-loop/checkpoint.js";
import {
  assertGate7DiagnosticUnlock,
  gate7UnlockRequired
} from "../../../bench/diagnostic-loop/gate7-unlock-admission.js";
import { DIAGNOSTIC_100Q_KPI_PROMOTION } from
  "../../../bench/diagnostics/stage-attribution/exposure/diagnostic-unlock.js";
import { runDiagnosticLoop } from "../../../bench/diagnostic-loop/run.js";
import { parseDiagnosticLoopArgs } from "../../../cli/diagnostic-loop/args.js";
import { digest, loopRequest, trackingAdapters } from "./fixture.js";
import { writeRebuildableUnlockRoot } from "./gate7-unlock-root-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gate 7 diagnostic unlock admission", () => {
  it("requires an unlock token for any window larger than 3", () => {
    expect(gate7UnlockRequired(loopRequest({ limit: 3 }))).toBe(false);
    expect(gate7UnlockRequired(loopRequest({ limit: 100 }))).toBe(true);
    expect(gate7UnlockRequired(loopRequest({
      requestedKeys: [digest("a"), digest("b"), digest("c"), digest("d")]
    }))).toBe(true);
  });

  it("admits a rebuilt current 3Q matrix token", async () => {
    const token = await writeToken();
    await assertGate7DiagnosticUnlock({
      unlockWorkRoot: token.unlockRoot,
      currentRequest: token.currentRequest,
      currentIdentity: await resolveDiagnosticLoopIdentity(token.currentRequest)
    });
  });

  it("fail-closes planted comparison without arm diagnostics", async () => {
    const token = await writeToken();
    await unlink(join(token.unlockRoot, "checkpoints", "control_recall.json"));
    await unlink(join(token.unlockRoot, "checkpoints", "treatment_recall.json"));
    await expect(admit(token)).rejects.toThrow(/missing|escapes|arm/iu);
  });

  it("fail-closes a miss-ledger planted outside the unlock work-root", async () => {
    const token = await writeToken();
    const outside = join(await tempRoot(), "foreign-miss-ledger.json");
    await copyFile(join(token.unlockRoot, "miss-ledger.json"), outside);
    const path = join(token.unlockRoot, "checkpoints", "miss_ledger.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as {
      artifact_paths: { missLedger: string };
    };
    const { checkpoint_digest: _digest, ...body } = {
      ...checkpoint,
      artifact_paths: { ...checkpoint.artifact_paths, missLedger: outside }
    };
    await writeFile(path, `${JSON.stringify({
      ...body,
      checkpoint_digest: checkpointDigest(body as never)
    })}\n`);
    await expect(admit(token)).rejects.toThrow(/escapes the unlock work-root/u);
  });

  it("fail-closes deleted and foreign arms", async () => {
    const token = await writeToken();
    await unlink(join(token.unlockRoot, "control.diagnostics.json.gz"));
    await expect(admit(token)).rejects.toThrow(/missing/u);

    const foreign = await writeToken({ failingMatrix: true });
    const mixed = await writeToken();
    await copyFile(
      join(foreign.unlockRoot, "treatment.diagnostics.json.gz"),
      join(mixed.unlockRoot, "treatment.diagnostics.json.gz")
    );
    await expect(admit(mixed)).rejects.toThrow(
      /does not rebuild from arm diagnostics/u
    );
  });

  it("fail-closes an arm/artifact mismatch", async () => {
    const token = await writeToken();
    const failed = await writeToken({ failingMatrix: true });
    await copyFile(
      join(failed.unlockRoot, "miss-ledger.json"),
      join(token.unlockRoot, "miss-ledger.json")
    );
    await expect(admit(token)).rejects.toThrow(
      /does not rebuild from arm diagnostics/u
    );
  });

  it("fail-closes bypass, foreign identity, old schema, and failed matrix", async () => {
    const token = await writeToken();
    const identity = await resolveDiagnosticLoopIdentity(token.currentRequest);
    await expect(assertGate7DiagnosticUnlock({
      unlockWorkRoot: undefined,
      currentRequest: token.currentRequest,
      currentIdentity: identity
    })).rejects.toThrow(/requires --gate7-unlock/u);

    await expect(assertGate7DiagnosticUnlock({
      unlockWorkRoot: join(tmpdir(), "missing-gate7-unlock"),
      currentRequest: token.currentRequest,
      currentIdentity: identity
    })).rejects.toThrow(/missing|ENOENT/u);

    const foreign = await writeToken({ promptDigest: digest("foreign-prompt") });
    await expect(assertGate7DiagnosticUnlock({
      unlockWorkRoot: foreign.unlockRoot,
      currentRequest: token.currentRequest,
      currentIdentity: identity
    })).rejects.toThrow(/code identity does not match/u);

    const oldSchema = await writeToken();
    await writeFile(join(oldSchema.unlockRoot, "miss-ledger.json"), `${JSON.stringify({
      schema_version: 5,
      kind: "f0_f2_vs_cached_f3",
      eligible: true
    })}\n`);
    await expect(admit(oldSchema)).rejects.toThrow(/historical diagnostic 100Q comparison/u);

    const failed = await writeToken({ failingMatrix: true });
    await expect(admit(failed)).rejects.toThrow(/not a passing current polarity matrix/u);
  });

  it("fail-closes missing, foreign, and drifted query-window caches", async () => {
    const token = await writeToken();
    const path = runRecordPath(token.unlockRoot);
    const record = JSON.parse(await readFile(path, "utf8")) as {
      identity: Record<string, unknown>;
    };
    const { query_factor_cache: _cache, ...identity } = record.identity;
    const unsigned = {
      ...record,
      identity,
      identity_digest: resolvedDiagnosticLoopIdentityDigest(identity as never)
    };
    const { run_record_digest: _digest, ...body } = unsigned;
    await writeFile(path, `${JSON.stringify({
      ...body,
      run_record_digest: runRecordDigest(body as never)
    })}\n`);
    await expect(admit(token)).rejects.toThrow(/missing a bound query cache file/u);

    const drifted = await writeToken();
    await writeFile(join(drifted.unlockRoot, "query-3q.json"), `${JSON.stringify({
      schema_version: 4, kind: "foreign"
    })}\n`);
    await expect(admit(drifted)).rejects.toThrow(/query cache/u);
  });

  it("fail-closes a forged or missing 3Q promotion receipt", async () => {
    const forged = await writeToken();
    const path = join(forged.unlockRoot, "report.json");
    const report = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, `${JSON.stringify({
      ...report,
      diagnostic_100q_promotion: { ...DIAGNOSTIC_100Q_KPI_PROMOTION, eligible: true }
    })}\n`);
    await expect(admit(forged)).rejects.toThrow(/does not bind the rebuilt polarity matrix/u);

    const missing = await writeToken();
    const missingReport = JSON.parse(
      await readFile(join(missing.unlockRoot, "report.json"), "utf8")
    ) as Record<string, unknown>;
    delete missingReport.diagnostic_100q_promotion;
    await writeFile(
      join(missing.unlockRoot, "report.json"),
      `${JSON.stringify(missingReport)}\n`
    );
    await expect(admit(missing)).rejects.toThrow(/does not bind the rebuilt polarity matrix/u);
  });

  it("fail-closes a missing or foreign no-provider receipt", async () => {
    const token = await writeToken();
    const path = join(token.unlockRoot, "checkpoints", "control_recall.json");
    const checkpoint = JSON.parse(await readFile(path, "utf8")) as {
      details: Record<string, unknown>;
    };
    const { checkpoint_digest: _digest, ...body } = {
      ...checkpoint,
      details: { ...checkpoint.details, no_provider_call_receipt: undefined }
    };
    await writeFile(path, `${JSON.stringify({
      ...body,
      checkpoint_digest: checkpointDigest(body as never)
    })}\n`);
    await expect(admit(token)).rejects.toThrow(
      /zero-call no-provider receipt|invalid diagnostic-loop checkpoint/u
    );
  });

  it("runs a 100Q diagnostic-loop only after the shared unlock owner admits the token", async () => {
    const token = await writeToken();
    const workRoot = await tempRoot();
    await expect(runDiagnosticLoop({
      workRoot,
      request: token.currentRequest,
      mode: "cache-only",
      adapters: trackingAdapters().adapters,
      argv: ["--limit", "100"],
      gate7UnlockPath: token.unlockRoot
    })).resolves.toMatchObject({ reportPath: expect.stringContaining("report.json") });
  });

  it("blocks diagnostic-loop limit>3 without the shared unlock owner", async () => {
    const workRoot = await tempRoot();
    await expect(runDiagnosticLoop({
      workRoot,
      request: loopRequest({ limit: 100 }),
      mode: "cache-only",
      adapters: trackingAdapters().adapters,
      argv: ["--limit", "100"]
    })).rejects.toThrow(/requires --gate7-unlock/u);
  });

  it("parses --gate7-unlock onto the shared run input", () => {
    const parsed = parseDiagnosticLoopArgs([
      "--work-root", "/tmp/loop",
      "--dataset-revision", digest("dataset"),
      "--requested-keys", digest("key-1"),
      "--provider-route", "mimo",
      "--model", "mimo-v2.5",
      "--request-profile", "mimo-v2.5-nonthinking-v1",
      "--prompt-digest", digest("prompt"),
      "--schema-digest", digest("schema"),
      "--operator-digest", digest("operator"),
      "--limit", "100",
      "--gate7-unlock", "/tmp/gate7-3q"
    ]);
    expect(parsed.gate7UnlockPath).toBe("/tmp/gate7-3q");
    expect(parsed.request.limit).toBe(100);
  });
});

async function writeToken(overrides: {
  readonly promptDigest?: string;
  readonly failingMatrix?: boolean;
} = {}) {
  return await writeRebuildableUnlockRoot({
    root: await tempRoot(),
    ...overrides
  });
}

async function admit(token: {
  readonly unlockRoot: string;
  readonly currentRequest: ReturnType<typeof loopRequest>;
}) {
  return await assertGate7DiagnosticUnlock({
    unlockWorkRoot: token.unlockRoot,
    currentRequest: token.currentRequest,
    currentIdentity: await resolveDiagnosticLoopIdentity(token.currentRequest)
  });
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gate7-unlock-"));
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}
