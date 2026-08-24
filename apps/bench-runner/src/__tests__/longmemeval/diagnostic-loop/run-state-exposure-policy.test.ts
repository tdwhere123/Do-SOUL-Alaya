// @ts-nocheck
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHED_F3_EXPOSURE_POLICY } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import {
  resolveDiagnosticLoopIdentity,
  resolvedDiagnosticLoopIdentityDigest
} from "../../../bench/diagnostic-loop/authority/identity.js";
import {
  persistRunRecord,
  readRunRecord,
  runRecordDigest,
  runRecordPath
} from "../../../bench/diagnostic-loop/run-state.js";
import {
  loopRequest,
  writeDiagnosticSnapshotFixture,
  writeQueryFactorCacheFixture
} from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop run-state exposure policy", () => {
  it("persists the policy home and fail-closes when denominator_kind drifts", async () => {
    expect(CACHED_F3_EXPOSURE_POLICY.denominator_kind).toBe("formed_osf_answerable");
    const workRoot = await mkdtemp(join(tmpdir(), "run-state-policy-"));
    roots.push(workRoot);
    const identity = await resolveDiagnosticLoopIdentity(loopRequest());
    expect(identity.treatment_exposure_policy).toEqual(CACHED_F3_EXPOSURE_POLICY);

    persistRunRecord({ workRoot, identity, mode: "run", argv: [] });
    const path = runRecordPath(workRoot);
    expect(readRunRecord(path).identity.treatment_exposure_policy).toEqual(
      CACHED_F3_EXPOSURE_POLICY
    );

    const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const { run_record_digest: _digest, ...unsigned } = {
      ...record,
      identity: {
        ...(record.identity as Record<string, unknown>),
        treatment_exposure_policy: {
          ...CACHED_F3_EXPOSURE_POLICY,
          denominator_kind: "all_evaluated_questions"
        }
      }
    };
    await writeFile(path, `${JSON.stringify({
      ...unsigned,
      run_record_digest: runRecordDigest(unsigned as never)
    }, null, 2)}\n`);

    expect(() => readRunRecord(path)).toThrow(/invalid diagnostic-loop run record/iu);
  });

  it("keeps embedding cache overlay off the sealed run identity", async () => {
    const workRoot = await mkdtemp(join(tmpdir(), "run-state-overlay-"));
    roots.push(workRoot);
    const identity = await resolveDiagnosticLoopIdentity(loopRequest({
      embeddingCacheOverlayReceiptPath: "/tmp/overlay-receipt.json"
    }));
    expect(identity.request).not.toHaveProperty("embeddingCacheOverlayReceiptPath");
    persistRunRecord({
      workRoot,
      identity,
      mode: "cache-only",
      argv: ["--embedding-cache-overlay", "/tmp/overlay-receipt.json"]
    });
    expect(readRunRecord(runRecordPath(workRoot)).identity.request)
      .not.toHaveProperty("embeddingCacheOverlayReceiptPath");
  });

  it("rejects archived query-cache schema 1/2 as current run-state authority", async () => {
    const workRoot = await mkdtemp(join(tmpdir(), "run-state-query-cache-"));
    roots.push(workRoot);
    const snapshot = await writeDiagnosticSnapshotFixture(workRoot, "run-state-cache");
    const cachePath = join(workRoot, "query-cache.json");
    await writeQueryFactorCacheFixture(cachePath, "Question q-1?");
    const identity = await resolveDiagnosticLoopIdentity(loopRequest({
      snapshotPath: snapshot,
      treatmentFactorCachePath: cachePath
    }));
    persistRunRecord({ workRoot, identity, mode: "run", argv: [] });
    const path = runRecordPath(workRoot);
    expect(readRunRecord(path).identity.query_factor_cache?.schema_version).toBe(4);

    for (const schema_version of [1, 2]) {
      const record = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      const query = {
        ...(record.identity as { query_factor_cache: Record<string, unknown> })
          .query_factor_cache,
        schema_version
      };
      const identity = {
        ...(record.identity as Record<string, unknown>),
        query_factor_cache: query
      };
      const { run_record_digest: _digest, ...body } = {
        ...record,
        identity,
        identity_digest: resolvedDiagnosticLoopIdentityDigest(identity as never)
      };
      await writeFile(path, `${JSON.stringify({
        ...body,
        run_record_digest: runRecordDigest(body as never)
      }, null, 2)}\n`);
      expect(() => readRunRecord(path)).toThrow(/invalid diagnostic-loop run record/iu);
    }
  });
});
