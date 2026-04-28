import { afterEach, describe, expect, it } from "vitest";
import {
  Phase5EventType,
  RunMode,
  RunState,
  WorkspaceKind,
  WorkspaceState,
  type FileRecord
} from "@do-what/protocol";
import { initDatabase } from "../db.js";
import { SqliteFileRepo } from "../repos/file-repo.js";
import { SqliteRunRepo } from "../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    file_id: "11111111-1111-4111-8111-111111111111",
    filename: "notes.md",
    mime_type: "text/markdown",
    size_bytes: 512,
    storage_path: "11111111-1111-4111-8111-111111111111.md",
    workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    created_at: "2026-03-31T00:00:00.000Z",
    ...overrides
  };
}

describe("SqliteFileRepo", () => {
  it("applies migration 022 and creates files indexes", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 22 LIMIT 1")
      .get() as { readonly version: number } | undefined;
    const table = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'files' LIMIT 1")
      .get() as { readonly name: string } | undefined;
    const workspaceIndex = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_workspace_id' LIMIT 1")
      .get() as { readonly name: string } | undefined;
    const runIndex = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_run_id' LIMIT 1")
      .get() as { readonly name: string } | undefined;

    expect(migration?.version).toBe(22);
    expect(table?.name).toBe("files");
    expect(workspaceIndex?.name).toBe("idx_files_workspace_id");
    expect(runIndex?.name).toBe("idx_files_run_id");
  });

  it("creates a file record and finds it by id", async () => {
    const { repo } = await createRepo();
    const record = createFileRecord();

    await expect(repo.create(record)).resolves.toEqual(record);
    await expect(repo.findById(record.file_id)).resolves.toEqual(record);
  });

  it("creates a file and event atomically with the event row inserted first", async () => {
    const { database, repo } = await createRepo();
    const record = createFileRecord();

    const result = await repo.createWithEvent(record, {
      event_type: Phase5EventType.FILE_UPLOADED,
      entity_type: "file",
      entity_id: record.file_id,
      workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      caused_by: "user",
      payload_json: {
        file_id: record.file_id,
        filename: record.filename,
        mime_type: record.mime_type,
        size_bytes: record.size_bytes,
        workspace_id: record.workspace_id,
        run_id: record.run_id
      }
    });

    const eventRow = database.connection
      .prepare("SELECT revision FROM event_log WHERE entity_id = ? LIMIT 1")
      .get(record.file_id) as { readonly revision: number } | undefined;

    expect(result.record).toEqual(record);
    expect(result.event.event_type).toBe(Phase5EventType.FILE_UPLOADED);
    expect(result.event.revision).toBe(0);
    expect(eventRow?.revision).toBe(0);
  });

  it("rolls back the event row when file creation fails", async () => {
    const { database, repo } = await createRepo();

    await repo.create(createFileRecord());

    await expect(
      repo.createWithEvent(
        createFileRecord({
          file_id: "22222222-2222-4222-8222-222222222222",
          storage_path: "11111111-1111-4111-8111-111111111111.md"
        }),
        {
          event_type: Phase5EventType.FILE_UPLOADED,
          entity_type: "file",
          entity_id: "22222222-2222-4222-8222-222222222222",
          workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          caused_by: "user",
          payload_json: {
            file_id: "22222222-2222-4222-8222-222222222222",
            filename: "duplicate.md",
            mime_type: "text/markdown",
            size_bytes: 128,
            workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
          }
        }
      )
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });

    const eventRow = database.connection
      .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_id = ?")
      .get("22222222-2222-4222-8222-222222222222") as { readonly count: number };

    expect(eventRow.count).toBe(0);
  });

  it("finds files by run and workspace and returns immutable records", async () => {
    const { repo } = await createRepo();

    const first = createFileRecord();
    const second = createFileRecord({
      file_id: "33333333-3333-4333-8333-333333333333",
      filename: "diagram.png",
      mime_type: "image/png",
      storage_path: "33333333-3333-4333-8333-333333333333.png",
      created_at: "2026-03-31T01:00:00.000Z"
    });
    const third = createFileRecord({
      file_id: "44444444-4444-4444-8444-444444444444",
      filename: "workspace.pdf",
      mime_type: "application/pdf",
      run_id: null,
      storage_path: "44444444-4444-4444-8444-444444444444.pdf",
      created_at: "2026-03-31T02:00:00.000Z"
    });

    await repo.create(first);
    await repo.create(second);
    await repo.create(third);

    const runFiles = await repo.findByRunId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const workspaceFiles = await repo.findByWorkspaceId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");

    expect(runFiles).toEqual([second, first]);
    expect(workspaceFiles).toEqual([third, second, first]);
    expect(await repo.findById("missing")).toBeNull();

    expect(() => {
      (runFiles[0] as { filename: string }).filename = "mutated.txt";
    }).toThrow(TypeError);
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteFileRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

  await workspaceRepo.create({
    workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  await runRepo.create({
    run_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    database,
    repo: new SqliteFileRepo(database)
  };
}
