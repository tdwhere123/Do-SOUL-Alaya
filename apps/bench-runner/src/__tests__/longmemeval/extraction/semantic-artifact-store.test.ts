import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const reserveOpenProbe = vi.hoisted(() => ({
  afterOpen: undefined as undefined | ((path: string) => void)
}));

vi.mock("../../../runs/extraction/cache/semantic-artifact/reservation-fd.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../runs/extraction/cache/semantic-artifact/reservation-fd.js")
  >();
  return {
    ...actual,
    openHeldReserveDescriptor(boundPath: string) {
      const fd = actual.openHeldReserveDescriptor(boundPath);
      reserveOpenProbe.afterOpen?.(boundPath);
      return fd;
    }
  };
});

import { withRootBoundDirectory } from
  "../../../runs/extraction/cache-audit/bounded-artifact-reader.js";
import { sealSemanticArtifact, SEMANTIC_ARTIFACT_MAX_BYTES } from
  "../../../runs/extraction/cache/semantic-artifact/contract.js";
import {
  admitSemanticArtifact,
  digestSemanticCacheState,
  digestSemanticOverlay,
  inspectSemanticArtifact,
  listSemanticArtifactInventory,
  persistRawArtifact,
  reclaimAbandonedReservation,
  recordSourceBinding,
  recordedSourceBindings,
  releaseSemanticArtifactReservation,
  reserveSemanticArtifact,
  semanticArtifactPath
} from "../../../runs/extraction/cache/semantic-artifact/store.js";
import {
  assertSemanticArtifactCompatibility,
  semanticTaskIdentity
} from "../../../runs/extraction/cache/semantic-artifact/admission-identity.js";
import {
  SEMANTIC_CAPABILITY as CAP,
  SEMANTIC_RAW as RAW,
  TOKEN_AWARE_POLICY,
  semanticArtifactUnsigned,
  semanticTask
} from "./semantic-artifact-fixture.js";
import { runSemanticFill } from
  "../../../runs/extraction/fill/semantic-fill-executor.js";
import {
  createOfflineSemanticEnvelope,
  createOfflineSemanticReplayForTasks
} from "../../../runs/extraction/fill/semantic-fill-envelope.js";
import { acquireExtractionCacheWriteLease } from
  "../../../runs/extraction/fill/manifest/fill-root-guard.js";

const CAP_B = "temporal_validity:v1";

async function admitTask(root: string, task = semanticTask()): Promise<void> {
  const rawJson = JSON.stringify({ signals: [{
    object_kind: "fact", confidence: 0.9,
    matched_text: task.text.replace(/^(?:User|Assistant): /u, ""),
    source_locator: {
      contract_version: task.binding.locator.contract_version,
      kind: "assertion_catalog",
      assertion_id: task.assertionId
    }
  }] });
  const report = await runSemanticFill({
    root, tasks: [task],
    envelope: createOfflineSemanticEnvelope({
      maxCalls: 1, maxFailures: 1, transportPolicy: TOKEN_AWARE_POLICY
    }),
    transport: createOfflineSemanticReplayForTasks({
      tasks: [task], transportPolicy: TOKEN_AWARE_POLICY,
      result: { kind: "raw", rawJson }
    })
  });
  expect(report.admitted).toBe(1);
}

describe("semantic artifact store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "semantic-artifact-"));
    persistRawArtifact(root, RAW);
  });

  afterEach(async () => {
    reserveOpenProbe.afterOpen = undefined;
    await rm(root, { recursive: true, force: true });
  });

  it("rejects semantic path traversal identities", () => {
    const task = semanticTask();
    expect(() => semanticArtifactPath(root, "../escape", CAP)).toThrow(/semantic key/u);
    expect(() => semanticArtifactPath(root, task.semanticKey, "../escape:v1")).toThrow();
  });

  it("rejects self-signed artifacts and round-trips verified raw admission", async () => {
    const task = semanticTask();
    const artifact = sealSemanticArtifact(semanticArtifactUnsigned(task));
    const token = reserveSemanticArtifact(root, task.semanticKey, CAP);
    expect(() => admitSemanticArtifact({
      root, admission: artifact as never, reservationToken: token, expectedIdentity: task
    })).toThrow(/verified admission handle/u);
    releaseSemanticArtifactReservation(root, task.semanticKey, CAP, token);
    await admitTask(root, task);
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("provider_backed");
  });

  it("does not report provider availability when raw evidence is missing or corrupt", async () => {
    const task = semanticTask();
    await admitTask(root, task);
    const artifact = inspectSemanticArtifact(root, task.semanticKey, CAP).artifact!;
    const rawPath = join(root, "raw", artifact.raw_response_digest!.slice(0, 2),
      `${artifact.raw_response_digest}.json`);
    rmSync(rawPath);
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("invalid");
    persistRawArtifact(root, RAW);
    writeFileSync(rawPath, "{}", "utf8");
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("invalid");
  });

  it("fails closed on partial JSON, digest mismatch, and final-entry symlink", () => {
    const task = semanticTask();
    const token = reserveSemanticArtifact(root, task.semanticKey, CAP);
    const path = semanticArtifactPath(root, task.semanticKey, CAP);
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("reserved");
    releaseSemanticArtifactReservation(root, task.semanticKey, CAP, token);
    writeFileSync(path, "{not json\n", "utf8");
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("invalid");
    const sealed = sealSemanticArtifact(semanticArtifactUnsigned(task));
    writeFileSync(path, `${JSON.stringify({ ...sealed, artifact_digest: "00".repeat(32) })}\n`, "utf8");
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("invalid");
    rmSync(path, { force: true });
    symlinkSync(join(root, "missing-target.json"), path);
    expect(inspectSemanticArtifact(root, task.semanticKey, CAP).status).toBe("invalid");
  });

  it("rejects parent symlinks without reading or writing outside the root", async () => {
    const task = semanticTask();
    const parent = await mkdtemp(join(tmpdir(), "semantic-parent-"));
    const outside = await mkdtemp(join(tmpdir(), "semantic-outside-"));
    const alias = join(parent, "alias");
    symlinkSync(outside, alias, "dir");
    try {
      expect(() => persistRawArtifact(alias, RAW)).toThrow(/stable real directory|symbolic|ENOTDIR/u);
      expect(existsSync(join(outside, "ROOT_KIND"))).toBe(false);
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
    expect(task.semanticKey).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("keeps writes on the held root inode across a real-path name swap", () => {
    const original = `${root}-held`;
    withRootBoundDirectory({ root, label: "swap falsifier" }, (stableRoot) => {
      renameSync(root, original);
      mkdirSync(root);
      writeFileSync(`${stableRoot}/held.txt`, "held", "utf8");
    });
    expect(existsSync(join(original, "held.txt"))).toBe(true);
    expect(existsSync(join(root, "held.txt"))).toBe(false);
    rmSync(root, { recursive: true, force: true });
    renameSync(original, root);
  });

  it("rejects an ancestor symlink introduced before an operation", () => {
    const task = semanticTask();
    const prefix = task.semanticKey.slice(0, 2);
    mkdirSync(join(root, prefix), { recursive: true });
    const outside = `${root}-outside`;
    mkdirSync(outside);
    renameSync(join(root, prefix), join(root, `${prefix}-original`));
    symlinkSync(outside, join(root, prefix), "dir");
    expect(() => reserveSemanticArtifact(root, task.semanticKey, CAP)).toThrow(/stable real directory|ENOTDIR/u);
    expect(readdirSync(outside)).toEqual([]);
    rmSync(join(root, prefix), { force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a second writer and a stale token", async () => {
    const task = semanticTask();
    const first = reserveSemanticArtifact(root, task.semanticKey, CAP);
    expect(() => reserveSemanticArtifact(root, task.semanticKey, CAP)).toThrow(/reservation is held/u);
    const artifact = sealSemanticArtifact(semanticArtifactUnsigned(task));
    expect(() => admitSemanticArtifact({
      root, admission: artifact as never, reservationToken: "not-the-token", expectedIdentity: task
    })).toThrow(/verified admission handle/u);
    releaseSemanticArtifactReservation(root, task.semanticKey, CAP, first);
    await admitTask(root, task);
    expect(() => reserveSemanticArtifact(root, task.semanticKey, CAP)).toThrow(/already admitted/u);
  });

  it("publishes bindings independently and separates overlay from full-state identity", async () => {
    const task = semanticTask();
    await admitTask(root, task);
    const beforeOverlay = digestSemanticOverlay(root);
    const beforeState = digestSemanticCacheState(root);
    recordSourceBinding(root, task.semanticKey, CAP, {
      ...task.binding, occurrenceIdentity: "77".repeat(32)
    });
    expect(recordedSourceBindings(root, task.semanticKey, CAP)).toHaveLength(2);
    expect(digestSemanticOverlay(root)).not.toBe(beforeOverlay);
    expect(digestSemanticCacheState(root)).toBe(beforeState);
  });

  it("keeps unrelated capabilities independently inventoried", async () => {
    const taskA = semanticTask();
    await admitTask(root, taskA);
    const taskB = { ...taskA, capability: CAP_B };
    const artifactB = sealSemanticArtifact(semanticArtifactUnsigned(taskB));
    const tokenB = reserveSemanticArtifact(root, taskB.semanticKey, CAP_B);
    expect(() => admitSemanticArtifact({
      root, admission: artifactB as never, reservationToken: tokenB, expectedIdentity: taskB
    })).toThrow(/verified admission handle/u);
    releaseSemanticArtifactReservation(root, taskB.semanticKey, CAP_B, tokenB);
    expect(listSemanticArtifactInventory(root)).toHaveLength(1);
  });

  it("rejects oversized raw bytes before creating a root", async () => {
    const emptyRoot = join(root, "oversized");
    expect(() => persistRawArtifact(emptyRoot, "x".repeat(SEMANTIC_ARTIFACT_MAX_BYTES + 1)))
      .toThrow(/size limit/u);
    expect(existsSync(emptyRoot)).toBe(false);
  });

  it("binds immutable raw evidence into cache state identity", () => {
    const before = digestSemanticCacheState(root);
    persistRawArtifact(root, '{"signals":[]}');
    expect(digestSemanticCacheState(root)).not.toBe(before);
  });

  it("rejects a foreign root marker", () => {
    writeFileSync(join(root, "ROOT_KIND"), "foreign\n", "utf8");
    expect(() => persistRawArtifact(root, RAW)).toThrow(/foreign ROOT_KIND/u);
  });

  it("reclaims malformed reservations under the serialized fill owner", () => {
    const task = semanticTask();
    const token = reserveSemanticArtifact(root, task.semanticKey, CAP);
    const reservation = `${semanticArtifactPath(root, task.semanticKey, CAP)}.reserve`;
    writeFileSync(reservation, "malformed\n", "utf8");
    const lease = acquireExtractionCacheWriteLease(root);
    try {
      reclaimAbandonedReservation(root, task.semanticKey, CAP, lease);
    } finally {
      lease.release();
    }
    expect(existsSync(reservation)).toBe(false);
    expect(token).toHaveLength(36);
  });

  it("recovers a malformed reservation before inventory digest", () => {
    const task = semanticTask();
    const token = reserveSemanticArtifact(root, task.semanticKey, CAP);
    const reservation = `${semanticArtifactPath(root, task.semanticKey, CAP)}.reserve`;
    writeFileSync(reservation, "malformed\n", "utf8");
    expect(() => digestSemanticCacheState(root)).not.toThrow();
    expect(existsSync(reservation)).toBe(false);
    expect(token).toHaveLength(36);
  });

  it("rejects a binding whose filename digest does not match its content", async () => {
    const task = semanticTask();
    await admitTask(root, task);
    const directory = join(root, "bindings", task.semanticKey, encodeURIComponent(CAP));
    writeFileSync(join(directory, `${"00".repeat(32)}.json`),
      `${JSON.stringify(task.binding, null, 2)}\n`, "utf8");
    expect(() => recordedSourceBindings(root, task.semanticKey, CAP))
      .toThrow(/filename digest mismatch/u);
  });

  it("does not treat an endpoint change as semantic incompatibility", async () => {
    const task = semanticTask();
    await admitTask(root, task);
    const artifact = inspectSemanticArtifact(root, task.semanticKey, CAP).artifact!;
    const shifted = { ...task, providerUrlSha256: "ff".repeat(32) };
    expect(semanticTaskIdentity(shifted)).toBe(semanticTaskIdentity(task));
    expect(() => assertSemanticArtifactCompatibility(shifted, artifact, false)).not.toThrow();
  });

  it("refuses to unlink a reservation redirected through a symlink", () => {
    const task = semanticTask();
    const token = reserveSemanticArtifact(root, task.semanticKey, CAP);
    const reservePath = `${semanticArtifactPath(root, task.semanticKey, CAP)}.reserve`;
    const victim = join(root, "victim.json");
    writeFileSync(victim, "keep-me\n", "utf8");
    rmSync(reservePath);
    symlinkSync(victim, reservePath);
    expect(() => releaseSemanticArtifactReservation(root, task.semanticKey, CAP, token))
      .toThrow(/regular file|token mismatch|reservation/u);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep-me\n");
  });

  it("does not delete a victim that replaced the reservation name after the held open", () => {
    const task = semanticTask();
    const token = reserveSemanticArtifact(root, task.semanticKey, CAP);
    const reservePath = `${semanticArtifactPath(root, task.semanticKey, CAP)}.reserve`;
    const victim = join(root, "victim.json");
    writeFileSync(victim, "keep-me\n", "utf8");
    let swapped = false;
    reserveOpenProbe.afterOpen = (path) => {
      if (swapped || !path.endsWith(".json.reserve")) return;
      swapped = true;
      const aside = `${dirname(reservePath)}/${basename(reservePath)}.aside`;
      fs.renameSync(reservePath, aside);
      fs.renameSync(victim, reservePath);
    };
    expect(() => releaseSemanticArtifactReservation(root, task.semanticKey, CAP, token))
      .toThrow(/replaced|token mismatch|regular file|uniquely linked/u);
    expect(fs.readFileSync(reservePath, "utf8")).toBe("keep-me\n");
  });

  it("uses bounded bytes for corrupt full-state inventory", () => {
    const task = semanticTask();
    const path = semanticArtifactPath(root, task.semanticKey, CAP);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{", "utf8");
    expect(() => digestSemanticCacheState(root)).toThrow(/JSON|semantic artifact/u);
    writeFileSync(path, "{x", "utf8");
    expect(() => digestSemanticCacheState(root)).toThrow(/JSON|semantic artifact/u);
  });
});
