import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  boundFileFullContentReadCount,
  hashRegularFileNoFollow,
  type OpenedFileSha256
} from "../../../runs/snapshot/bound-file.js";
import { SNAPSHOT_SEED_IDENTITY } from "../../../shared/version.js";
import {
  createRecallEvalPagerSession,
  type RecallEvalPagerIpcHost,
  type RecallEvalPagerIpcProcess
} from "../../../runs/lifecycle/recall-eval/recall-eval-process/ipc-client.js";
import {
  proveParentOpenedFileProofs,
  seedParentOpenedFileProofs
} from "../../../runs/lifecycle/recall-eval/recall-eval-process/parent-opened-file-proofs.js";
import {
  digestWorkspaceSliceSnapshotIdentity,
  WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
  WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
  WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME,
  WORKSPACE_SLICE_SQLITE_KIND
} from "../../../runs/snapshot/recall-eval/workspace-slice/slice-snapshot.js";
import { SEALED_SLICE_CACHE_IDENTITY_FILENAME } from
  "../../../runs/snapshot/recall-eval/workspace-slice/sealed-cache.js";

const childScript = fileURLToPath(
  new URL("./parent-opened-file-proofs-child.mjs", import.meta.url)
);
const roots: string[] = [];
const sessions: ReturnType<typeof createRecallEvalPagerSession>[] = [];

afterEach(async () => {
  const pending = sessions.splice(0);
  await Promise.all(pending.map((session) => session.close().catch(() => undefined)));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("parent-opened snapshot identity", () => {
  it("recycle child skips packed full-read after parent proof", async () => {
    const snapshot = await packedFixture();
    const before = boundFileFullContentReadCount();
    const proved = proveParentOpenedFileProofs(openPayload(snapshot)) as {
      readonly parentOpenedFileProofs: Readonly<Record<string, OpenedFileSha256>>;
    };
    expect(boundFileFullContentReadCount() - before).toBe(1);

    const first = runProofChild({
      proofs: proved.parentOpenedFileProofs,
      hashPaths: [snapshot.path]
    });
    const recycled = runProofChild({
      proofs: proved.parentOpenedFileProofs,
      hashPaths: [snapshot.path]
    });
    expect(first.reads).toBe(0);
    expect(recycled.reads).toBe(0);
    expect(first.sha256s).toEqual([snapshot.sha256]);
    expect(recycled.sha256s).toEqual([snapshot.sha256]);
    expect(boundFileFullContentReadCount() - before).toBe(1);
  });

  it("fails closed in a new process when inode or size drift after proof", async () => {
    const snapshot = await packedFixture();
    const proved = proveParentOpenedFileProofs(openPayload(snapshot)) as {
      readonly parentOpenedFileProofs: Readonly<Record<string, OpenedFileSha256>>;
    };
    const original = `${snapshot.path}.original`;
    renameSync(snapshot.path, original);
    writeFileSync(snapshot.path, "replacement inode");
    const drifted = runProofChild({
      proofs: proved.parentOpenedFileProofs,
      hashPaths: [snapshot.path]
    }, { allowFailure: true });
    expect(drifted.status).not.toBe(0);
    expect(drifted.stderr).toMatch(/changed/u);

    writeFileSync(snapshot.path, Buffer.concat([
      Buffer.from("trusted snapshot bytes", "utf8"),
      Buffer.from("!")
    ]));
    const resized = runProofChild({
      proofs: proved.parentOpenedFileProofs,
      hashPaths: [snapshot.path]
    }, { allowFailure: true });
    expect(resized.status).not.toBe(0);
    expect(resized.stderr).toMatch(/changed/u);
  });

  it("hashes once in a new process when parent proof is absent", async () => {
    const snapshot = await packedFixture();
    const child = runProofChild({
      hashPaths: [snapshot.path]
    });
    expect(child.reads).toBe(1);
    expect(child.sha256s).toEqual([snapshot.sha256]);
  });

  it("re-sends parent proofs to a recycled pager child", async () => {
    const snapshot = await packedFixture();
    const recorded = recordingHost();
    const session = createRecallEvalPagerSession({ host: recorded.host });
    sessions.push(session);
    const before = boundFileFullContentReadCount();
    await session.open(openPayload(snapshot));
    await session.recall({ questionId: "q1" });
    await session.recycle();
    await session.recall({ questionId: "q2" });
    expect(boundFileFullContentReadCount() - before).toBe(1);
    expect(recorded.opens).toHaveLength(2);
    const firstProofs = openedProofs(recorded.opens[0]);
    const recycledProofs = openedProofs(recorded.opens[1]);
    expect(firstProofs[snapshot.path]?.sha256).toBe(snapshot.sha256);
    expect(recycledProofs).toEqual(firstProofs);
  });

  it("seeds sealed slice main-file proofs without a child rehash", async () => {
    const snapshot = await packedFixture();
    const slicePath = join(
      `${snapshot.path}.workspace-slices`,
      encodeURIComponent("workspace-a"),
      "alaya.db"
    );
    const sliceBytes = Buffer.from("sealed slice bytes", "utf8");
    const sliceSha = sha256(sliceBytes);
    mkdirSync(dirname(slicePath), { recursive: true });
    writeFileSync(slicePath, sliceBytes);
    writeSliceReceipt(slicePath, "workspace-a", sliceSha);
    writeSealedIdentity(snapshot, "workspace-a", sliceSha);

    const before = boundFileFullContentReadCount();
    const proved = proveParentOpenedFileProofs(openPayload(snapshot)) as {
      readonly parentOpenedFileProofs: Readonly<Record<string, OpenedFileSha256>>;
    };
    expect(boundFileFullContentReadCount() - before).toBe(2);
    expect(proved.parentOpenedFileProofs[slicePath]?.sha256).toBe(sliceSha);

    const child = runProofChild({
      proofs: proved.parentOpenedFileProofs,
      hashPaths: [snapshot.path, slicePath]
    });
    expect(child.reads).toBe(0);
    expect(child.sha256s).toEqual([snapshot.sha256, sliceSha]);
  });

  it("absent payload proofs still hash in-process once", async () => {
    const snapshot = await packedFixture();
    seedParentOpenedFileProofs(openPayload(snapshot));
    const before = boundFileFullContentReadCount();
    expect(hashRegularFileNoFollow(snapshot.path)).toBe(snapshot.sha256);
    expect(hashRegularFileNoFollow(snapshot.path)).toBe(snapshot.sha256);
    expect(boundFileFullContentReadCount() - before).toBe(1);
  });
});

const childScriptArgs = [
  "--experimental-strip-types",
  "--no-warnings",
  childScript
];

function runProofChild(
  payload: {
    readonly proofs?: Readonly<Record<string, OpenedFileSha256>>;
    readonly hashPaths?: readonly string[];
  },
  options: { readonly allowFailure?: boolean } = {}
): {
  readonly reads: number;
  readonly sha256s: readonly string[];
  readonly status: number | null;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [
    ...childScriptArgs,
    JSON.stringify(payload)
  ], {
    encoding: "utf8",
    timeout: 15_000
  });
  if (result.status !== 0) {
    if (options.allowFailure === true) {
      return {
        reads: -1,
        sha256s: [],
        status: result.status,
        stderr: result.stderr
      };
    }
    throw new Error(result.stderr || result.stdout || `child exited ${result.status}`);
  }
  const parsed = JSON.parse(result.stdout) as {
    readonly reads: number;
    readonly sha256s: readonly string[];
  };
  return { ...parsed, status: result.status, stderr: result.stderr };
}

function recordingHost(): {
  readonly opens: unknown[];
  readonly host: RecallEvalPagerIpcHost;
} {
  const opens: unknown[] = [];
  let nextPid = 7000;
  return {
    opens,
    host: {
      spawn(): RecallEvalPagerIpcProcess {
        const pid = nextPid += 1;
        const listeners = new Map<string, Array<(...args: never[]) => void>>();
        const child: RecallEvalPagerIpcProcess = {
          pid,
          send(message, callback) {
            const request = message as {
              readonly id: number;
              readonly op: string;
              readonly open?: unknown;
              readonly recall?: { readonly questionId?: string };
            };
            if (request.op === "open") opens.push(request.open);
            queueMicrotask(() => {
              emit(listeners, "message", reply(request));
            });
            callback?.(null);
            return true;
          },
          on(event, listener) {
            const current = listeners.get(event) ?? [];
            current.push(listener as (...args: never[]) => void);
            listeners.set(event, current);
            return child;
          },
          kill() {
            return true;
          }
        };
        return child;
      }
    }
  };
}

function reply(request: {
  readonly id: number;
  readonly op: string;
  readonly recall?: { readonly questionId?: string };
}): unknown {
  if (request.op === "recall") {
    return {
      id: request.id,
      ok: true,
      pack: {
        questionId: request.recall?.questionId ?? "q",
        diagnostics: {}
      }
    };
  }
  return { id: request.id, ok: true, pid: 1 };
}

function emit(
  listeners: Map<string, Array<(...args: never[]) => void>>,
  event: string,
  message: unknown
): void {
  for (const listener of listeners.get(event) ?? []) {
    (listener as (value: unknown) => void)(message);
  }
}

async function packedFixture(): Promise<{
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "parent-opened-proof-"));
  roots.push(root);
  const path = join(root, "snapshot.db");
  const bytes = Buffer.from("trusted snapshot bytes", "utf8");
  await writeFile(path, bytes);
  return { root, path, sha256: sha256(bytes) };
}

function openPayload(snapshot: {
  readonly root: string;
  readonly path: string;
  readonly sha256: string;
}): Record<string, unknown> {
  return {
    dataDirRoot: snapshot.root,
    options: { snapshotDbPath: snapshot.path },
    manifest: {
      artifact_integrity: { db_sha256: snapshot.sha256 }
    }
  };
}

function openedProofs(payload: unknown): Readonly<Record<string, OpenedFileSha256>> {
  if (typeof payload !== "object" || payload === null) return {};
  const proofs = (payload as { parentOpenedFileProofs?: unknown }).parentOpenedFileProofs;
  if (typeof proofs !== "object" || proofs === null) return {};
  return proofs as Readonly<Record<string, OpenedFileSha256>>;
}

function writeSliceReceipt(
  dbPath: string,
  workspaceId: string,
  sqliteMainFileSha256: string
): void {
  writeFileSync(join(dirname(dbPath), WORKSPACE_SLICE_SNAPSHOT_SIDECAR_FILENAME), `${JSON.stringify({
    schema_version: 1,
    kind: WORKSPACE_SLICE_SQLITE_KIND,
    recipe_id: WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
    recipe_version: WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
    workspace_id: workspaceId,
    sqlite_main_file_sha256: sqliteMainFileSha256,
    snapshot_digest: digestWorkspaceSliceSnapshotIdentity({
      workspaceId,
      sqliteMainFileSha256
    })
  })}\n`);
}

function writeSealedIdentity(
  snapshot: { readonly path: string; readonly sha256: string },
  workspaceId: string,
  sliceSha: string
): void {
  writeFileSync(join(`${snapshot.path}.workspace-slices`, SEALED_SLICE_CACHE_IDENTITY_FILENAME), `${JSON.stringify({
    schema_version: 1,
    packed_db_sha256: snapshot.sha256,
    snapshot_db_sha256: snapshot.sha256,
    recipe_id: WORKSPACE_SLICE_EXPLODE_RECIPE_ID,
    recipe_version: WORKSPACE_SLICE_EXPLODE_RECIPE_VERSION,
    seed_identity: SNAPSHOT_SEED_IDENTITY,
    workspace_ids: [workspaceId],
    slice_snapshot_digests: {
      [workspaceId]: digestWorkspaceSliceSnapshotIdentity({
        workspaceId,
        sqliteMainFileSha256: sliceSha
      })
    }
  })}\n`);
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
