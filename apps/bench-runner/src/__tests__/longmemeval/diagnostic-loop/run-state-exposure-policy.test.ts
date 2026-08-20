import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CACHED_F3_EXPOSURE_POLICY } from
  "../../../bench/diagnostics/stage-attribution/exposure/contract.js";
import { resolveDiagnosticLoopIdentity } from
  "../../../bench/diagnostic-loop/authority/identity.js";
import {
  persistRunRecord,
  readRunRecord,
  runRecordDigest,
  runRecordPath
} from "../../../bench/diagnostic-loop/run-state.js";
import { loopRequest } from "./fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("diagnostic-loop run-state exposure policy", () => {
  it("persists the policy home and fail-closes when declared_minimum_rate drifts", async () => {
    expect(CACHED_F3_EXPOSURE_POLICY.declared_minimum_rate).toBe(1);
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
          declared_minimum_rate: CACHED_F3_EXPOSURE_POLICY.declared_minimum_rate - 1
        }
      }
    };
    await writeFile(path, `${JSON.stringify({
      ...unsigned,
      run_record_digest: runRecordDigest(unsigned as never)
    }, null, 2)}\n`);

    expect(() => readRunRecord(path)).toThrow(/invalid diagnostic-loop run record/iu);
  });
});
