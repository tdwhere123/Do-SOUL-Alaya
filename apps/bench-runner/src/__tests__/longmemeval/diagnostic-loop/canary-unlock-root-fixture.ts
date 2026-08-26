// @ts-nocheck
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { materializeOpenSemanticFactorFormation } from "@do-soul/alaya-core";
import { persistRunRecord } from "../../../bench/diagnostic-loop/run-state.js";
import { resolveDiagnosticLoopIdentity } from
  "../../../bench/diagnostic-loop/authority/identity.js";
import { checkpointDigest } from "../../../bench/diagnostic-loop/checkpoint.js";
import { writeDiagnosticLoopReport } from "../../../bench/diagnostic-loop/report.js";
import { missLedgerContentIdentity } from
  "../../../bench/diagnostic-loop/miss-ledger-authority.js";
import type { DiagnosticLoopCheckpoint } from "../../../bench/diagnostic-loop/types.js";
import { rebuildDiagnostic100QComparison } from
  "../../../bench/diagnostics/stage-attribution/exposure/rebuild-comparison.js";
import {
  createQuerySemanticFactorCache,
  writeQuerySemanticFactorCache
} from "../../../bench/query-factors/query-semantic-factor-cache.js";
import { currentSnapshotSidecarFor } from "../snapshot/current-snapshot-fixture.js";
import { loopIdentity, loopRequest, writeDiagnosticSnapshotFixture } from "./fixture.js";
import {
  controlCanaryDiagnostics,
  failingTreatmentCanaryDiagnostics,
  passingTreatmentCanaryDiagnostics
} from "./canary-arm-diagnostics.js";

const SNAPSHOT_QUERY = currentSnapshotSidecarFor("q-1").questions[0]!.question;

export async function writeRebuildableUnlockRoot(input: {
  readonly root: string;
  readonly promptDigest?: string;
  readonly failingMatrix?: boolean;
}): Promise<{
  readonly unlockRoot: string;
  readonly currentRequest: ReturnType<typeof loopRequest>;
}> {
  const unlockRoot = input.root;
  const currentRoot = join(unlockRoot, "current-window");
  await mkdir(join(unlockRoot, "checkpoints"), { recursive: true });
  await mkdir(currentRoot, { recursive: true });
  const snapshot3q = await writeDiagnosticSnapshotFixture(unlockRoot, "snapshot-3q");
  const snapshot100q = await writeDiagnosticSnapshotFixture(currentRoot, "snapshot-100q");
  const cache3q = join(unlockRoot, "query-3q.json");
  const cache100q = join(currentRoot, "query-100q.json");
  await writeQueryCache(cache3q, [SNAPSHOT_QUERY]);
  await writeQueryCache(cache100q, [SNAPSHOT_QUERY]);
  const request3q = loopRequest({
    limit: 3,
    offset: 0,
    snapshotPath: snapshot3q,
    treatmentFactorCachePath: cache3q,
    ...(input.promptDigest === undefined ? {} : { promptDigest: input.promptDigest })
  });
  const identity = await resolveDiagnosticLoopIdentity(request3q);
  const runDigest = persistRunRecord({
    workRoot: unlockRoot, identity, mode: "run", argv: []
  });
  const controlPath = join(unlockRoot, "control.diagnostics.json.gz");
  const treatmentPath = join(unlockRoot, "treatment.diagnostics.json.gz");
  await writeArmGzip(controlPath, controlCanaryDiagnostics());
  await writeArmGzip(
    treatmentPath,
    input.failingMatrix === true
      ? failingTreatmentCanaryDiagnostics()
      : passingTreatmentCanaryDiagnostics()
  );
  const comparison = await rebuildDiagnostic100QComparison({
    controlDiagnosticsPath: controlPath,
    treatmentDiagnosticsPath: treatmentPath
  });
  const missLedgerPath = join(unlockRoot, "miss-ledger.json");
  await writeFile(missLedgerPath, `${JSON.stringify(comparison)}\n`);
  const control = recallCheckpoint(unlockRoot, "control_recall", controlPath, runDigest);
  const treatment = recallCheckpoint(unlockRoot, "treatment_recall", treatmentPath, runDigest);
  const miss = missCheckpoint(unlockRoot, missLedgerPath, control, treatment, runDigest, comparison);
  await writeFile(join(unlockRoot, "checkpoints", "control_recall.json"),
    `${JSON.stringify(control)}\n`);
  await writeFile(join(unlockRoot, "checkpoints", "treatment_recall.json"),
    `${JSON.stringify(treatment)}\n`);
  await writeFile(join(unlockRoot, "checkpoints", "miss_ledger.json"),
    `${JSON.stringify(miss)}\n`);
  writeDiagnosticLoopReport({
    workRoot: unlockRoot,
    identity: request3q,
    identityDigest: identity.identity_digest,
    checkpoints: new Map([
      ["control_recall", control],
      ["treatment_recall", treatment],
      ["miss_ledger", miss]
    ]),
    avoidedWork: {
      phasesSkipped: 0, providerCallsAvoided: 0, questionsSkipped: 0, snapshotsReused: 0
    },
    skippedPhases: []
  });
  return {
    unlockRoot,
    currentRequest: loopRequest({
      limit: 100,
      snapshotPath: snapshot100q,
      treatmentFactorCachePath: cache100q,
      ...(input.promptDigest === undefined ? {} : { promptDigest: input.promptDigest })
    })
  };
}

async function writeQueryCache(path: string, sourceTexts: readonly string[]): Promise<void> {
  const identity = loopIdentity();
  await writeQuerySemanticFactorCache(path, createQuerySemanticFactorCache({
    model_id: identity.model,
    request_profile: identity.requestProfile as "mimo-v2.5-nonthinking-v1",
    provider_url: identity.providerRoute,
    entries: sourceTexts.map((source_text) => {
      const capture = materializeOpenSemanticFactorFormation({
        source_kind: "query", source_text
      });
      return { source_text, source_sha256: capture.source_sha256!, capture };
    })
  }));
}

async function writeArmGzip(
  path: string,
  diagnostics: ReturnType<typeof controlCanaryDiagnostics>
): Promise<void> {
  await writeFile(path, gzipSync(JSON.stringify({
    schema_version: 2,
    kind: "recall_eval_diagnostics",
    questions: diagnostics.map((row) => ({ diagnostics: row }))
  })));
}

function recallCheckpoint(
  workRoot: string,
  phase: "control_recall" | "treatment_recall",
  diagnostics: string,
  identityDigest: string
): DiagnosticLoopCheckpoint {
  const body = {
    schema_version: 3 as const,
    kind: "diagnostic_loop_checkpoint" as const,
    phase,
    status: "completed" as const,
    identity_digest: identityDigest,
    content_identity: identityDigest,
    depends_on: {},
    physical_calls: 0,
    avoided_work: {
      phasesSkipped: 0, providerCallsAvoided: 0, questionsSkipped: 0, snapshotsReused: 0
    },
    artifact_paths: {
      snapshot: join(workRoot, "snapshot.db"),
      kpi: join(workRoot, `${phase}-kpi.json`),
      report: join(workRoot, `${phase}-report.json`),
      diagnostics
    },
    details: {
      no_provider_call_receipt: {
        schema_version: 1, kind: "internal_no_provider_port",
        provider_port: "absent", physical_calls: 0
      },
      cache_identity: identityDigest,
      snapshot_identity: identityDigest
    },
    completed_at: "2026-08-19T00:00:00.000Z"
  };
  return { ...body, checkpoint_digest: checkpointDigest(body) };
}

function missCheckpoint(
  workRoot: string,
  missLedger: string,
  control: DiagnosticLoopCheckpoint,
  treatment: DiagnosticLoopCheckpoint,
  identityDigest: string,
  comparison: Awaited<ReturnType<typeof rebuildDiagnostic100QComparison>>
): DiagnosticLoopCheckpoint {
  const body = {
    schema_version: 3 as const,
    kind: "diagnostic_loop_checkpoint" as const,
    phase: "miss_ledger" as const,
    status: "completed" as const,
    identity_digest: identityDigest,
    content_identity: missLedgerContentIdentity(control, treatment),
    depends_on: {
      control_recall: control.content_identity,
      treatment_recall: treatment.content_identity
    },
    physical_calls: 0,
    avoided_work: {
      phasesSkipped: 0, providerCallsAvoided: 0, questionsSkipped: 0, snapshotsReused: 0
    },
    artifact_paths: { missLedger },
    details: {
      no_provider_call_receipt: {
        schema_version: 1, kind: "internal_no_provider_port",
        provider_port: "absent", physical_calls: 0
      },
      diagnostic_100q_unlock: comparison.diagnostic_100q_unlock,
      canary_polarity_matrix: comparison.canary_polarity_matrix,
      exposure_sli: comparison.exposure_sli
    },
    completed_at: "2026-08-19T00:00:00.000Z"
  };
  return { ...body, checkpoint_digest: checkpointDigest(body) };
}
