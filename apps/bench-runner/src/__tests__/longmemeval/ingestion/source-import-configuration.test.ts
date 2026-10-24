import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { samePhysicalLocation } from "../../../runs/fs/opened-contained-path.js";
import type { LongMemEvalQuestion } from "../../../datasets/longmemeval/ingestion/dataset.js";

const boundary = vi.hoisted(() => ({ load: vi.fn(), start: vi.fn() }));
vi.mock("../../../datasets/longmemeval/ingestion/fetch.js", () => ({ loadDatasetWindowWithIdentity: boundary.load }));
vi.mock("../../../harness/daemon.js", () => ({ startBenchDaemon: boundary.start }));
import { prepareSourceRecordsSnapshot, type SourceRecordsImportEffects } from "../../../runs/snapshot/source-records/prepare.js";

const roots: string[] = [];
afterEach(async () => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it("rejects unsupported private effect options before loading the dataset or creating preparation state", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-import-config-")); roots.push(root);
  const effects: SourceRecordsImportEffects = { configDirectoryRoot: root, sqliteWriteQueue: "disabled",
    embeddingStartupProbe: "omit", gardenCompute: "disabled" };
  const input = { snapshotPath: join(root, "snapshot.sqlite"), dataDirRoot: join(root, "live"),
    offset: 0, limit: 1, recordedAt: "2026-09-13T00:00:00.000Z", producerCommit: "a".repeat(40) };
  for (const [key, value] of [["sqliteWriteQueue", "enabled"], ["embeddingStartupProbe", "eager"],
    ["gardenCompute", "enabled"], ["unexpected", true]] as const) {
    await expect(prepareSourceRecordsSnapshot({ ...input, importEffects: { ...effects, [key]: value } as SourceRecordsImportEffects })).rejects.toThrow();
  }
  await expect(prepareSourceRecordsSnapshot({ ...input, importEffects: {
    ...effects, configDirectoryRoot: join(root, "absent") } })).rejects.toThrow();
  expect(boundary.load).not.toHaveBeenCalled();
  expect(boundary.start).not.toHaveBeenCalled();
  expect(await readdir(root)).toEqual([]);
});

it("pins a relative config root before asynchronous dataset loading can change cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "source-import-captured-root-")); roots.push(root);
  const before = join(root, "before"), after = join(root, "after");
  await mkdir(join(before, "config"), { recursive: true });
  await mkdir(join(after, "config"), { recursive: true });
  let release!: (value: unknown) => void;
  boundary.load.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
  boundary.start.mockRejectedValueOnce(new Error("captured launch boundary"));
  const originalCwd = process.cwd();
  try {
    process.chdir(before);
    const prepared = prepareSourceRecordsSnapshot({ snapshotPath: join(root, "snapshot.sqlite"),
      dataDirRoot: join(root, "live"), offset: 0, limit: 1,
      recordedAt: "2026-09-13T00:00:00.000Z", producerCommit: "a".repeat(40),
      importEffects: { configDirectoryRoot: "config", sqliteWriteQueue: "disabled",
        embeddingStartupProbe: "omit", gardenCompute: "disabled" } });
    const rejection = expect(prepared).rejects.toThrow("captured launch boundary");
    expect(boundary.load).toHaveBeenCalledOnce();
    process.chdir(after);
    release({ sha256: "b".repeat(64), questions: [{
      question_id: "captured-root-question", question_type: "single-session-user",
      question: "Where is the notebook stored?", answer: "On the shelf.",
      question_date: "2026-09-13T00:00:00.000Z",
      haystack_session_ids: ["captured-root-session"],
      haystack_dates: ["2026-09-12T00:00:00.000Z"],
      haystack_sessions: [[{ role: "user", content: "The notebook is stored on the shelf." }]],
      answer_session_ids: ["captured-root-session"]
    } satisfies LongMemEvalQuestion] });
    await rejection;
    expect(boundary.start).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      configDirectoryRoot: expect.any(String), dataDirRoot: join(root, "live") }));
    const captured = boundary.start.mock.calls[0]![0].configDirectoryRoot;
    expect(samePhysicalLocation(captured, join(before, "config"))).toBe(true);
    expect(samePhysicalLocation(captured, join(after, "config"))).toBe(false);
    expect(await readdir(join(before, "config"))).toEqual([]);
    expect(await readdir(join(after, "config"))).toEqual([]);
  } finally { process.chdir(originalCwd); }
});
