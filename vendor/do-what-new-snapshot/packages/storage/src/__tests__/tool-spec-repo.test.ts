import { afterEach, describe, expect, it } from "vitest";
import type { ToolSpec } from "@do-what/protocol";
import { initDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { SqliteToolSpecRepo } from "../index.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createToolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    tool_id: "tools.read_file",
    category: "read",
    description: "Read a file from the workspace.",
    scope_guard: "workspace",
    read_only: true,
    destructive: false,
    concurrency_safe: true,
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: true,
    ...overrides
  };
}

describe("SqliteToolSpecRepo", () => {
  it("round-trips a tool spec and restores boolean columns from integer storage", async () => {
    const { database, repo } = createRepo();
    const spec = createToolSpec();

    await expect(repo.insert(spec)).resolves.toEqual(spec);

    const rawRow = database.connection
      .prepare(
        `SELECT read_only, destructive, concurrency_safe, requires_confirmation,
                requires_evidence_reopen, fast_path_eligible
         FROM tool_specs
         WHERE tool_id = ?`
      )
      .get(spec.tool_id) as
      | {
          readonly read_only: number;
          readonly destructive: number;
          readonly concurrency_safe: number;
          readonly requires_confirmation: number;
          readonly requires_evidence_reopen: number;
          readonly fast_path_eligible: number;
        }
      | undefined;

    expect(rawRow).toEqual({
      read_only: 1,
      destructive: 0,
      concurrency_safe: 1,
      requires_confirmation: 0,
      requires_evidence_reopen: 0,
      fast_path_eligible: 1
    });

    const found = await repo.findById(spec.tool_id);

    expect(found).toEqual(spec);
    expect(found?.read_only).toBe(true);
    expect(found?.destructive).toBe(false);
    expect(found?.concurrency_safe).toBe(true);
    expect(found?.requires_confirmation).toBe(false);
    expect(found?.requires_evidence_reopen).toBe(false);
    expect(found?.fast_path_eligible).toBe(true);
  });

  it("lists all inserted tool specs ordered by tool_id", async () => {
    const { repo } = createRepo();

    await repo.insert(
      createToolSpec({
        tool_id: "tools.write_file",
        category: "write",
        description: "Write a file to the workspace.",
        read_only: false,
        fast_path_eligible: false
      })
    );
    await repo.insert(createToolSpec({ tool_id: "tools.read_file" }));
    await repo.insert(
      createToolSpec({
        tool_id: "tools.validate_path",
        category: "validation",
        description: "Validate a filesystem path."
      })
    );

    await expect(repo.list()).resolves.toEqual([
      createToolSpec({ tool_id: "tools.read_file" }),
      createToolSpec({
        tool_id: "tools.validate_path",
        category: "validation",
        description: "Validate a filesystem path."
      }),
      createToolSpec({
        tool_id: "tools.write_file",
        category: "write",
        description: "Write a file to the workspace.",
        read_only: false,
        fast_path_eligible: false
      })
    ]);
  });

  it("deletes a tool spec and then returns null from findById", async () => {
    const { repo } = createRepo();
    const spec = createToolSpec();

    await repo.insert(spec);
    await repo.delete(spec.tool_id);

    await expect(repo.findById(spec.tool_id)).resolves.toBeNull();
  });

  it("updates an existing tool spec", async () => {
    const { repo } = createRepo();
    const spec = createToolSpec();

    await repo.insert(spec);

    const updated = await repo.update(
      createToolSpec({
        tool_id: spec.tool_id,
        description: "Read a file with the latest description."
      })
    );

    expect(updated.description).toBe("Read a file with the latest description.");
    await expect(repo.findById(spec.tool_id)).resolves.toEqual(updated);
  });

  it("throws NOT_FOUND when updating a missing tool spec", async () => {
    const { repo } = createRepo();

    await expect(repo.update(createToolSpec())).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("rejects protocol-invalid categories before persistence", async () => {
    const { database, repo } = createRepo();
    const invalidSpec = {
      ...createToolSpec(),
      category: "invalid-category"
    } as unknown as ToolSpec;

    await expect(repo.insert(invalidSpec)).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });

    const rawRow = database.connection
      .prepare("SELECT tool_id FROM tool_specs WHERE tool_id = ?")
      .get(invalidSpec.tool_id);

    expect(rawRow).toBeUndefined();
  });

  it("rejects protocol-invalid inserts before persistence", async () => {
    const { database, repo } = createRepo();
    const invalidSpec = {
      ...createToolSpec(),
      description: ""
    } as unknown as ToolSpec;

    await expect(repo.insert(invalidSpec)).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });

    const rawRow = database.connection
      .prepare("SELECT tool_id FROM tool_specs WHERE tool_id = ?")
      .get(invalidSpec.tool_id);

    expect(rawRow).toBeUndefined();
    await expect(repo.findById(invalidSpec.tool_id)).resolves.toBeNull();
  });

  it("rejects protocol-invalid updates before persistence", async () => {
    const { database, repo } = createRepo();
    const spec = createToolSpec();
    await repo.insert(spec);

    const invalidUpdate = {
      ...spec,
      description: ""
    } as unknown as ToolSpec;

    await expect(repo.update(invalidUpdate)).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });

    const rawRow = database.connection
      .prepare("SELECT description FROM tool_specs WHERE tool_id = ?")
      .get(spec.tool_id) as { readonly description: string } | undefined;

    expect(rawRow).toEqual({ description: spec.description });
    await expect(repo.findById(spec.tool_id)).resolves.toEqual(spec);
  });

  it("returns null when a tool spec is not found", async () => {
    const { repo } = createRepo();

    await expect(repo.findById("tools.missing")).resolves.toBeNull();
  });
});

function createRepo(): {
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteToolSpecRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  return {
    database,
    repo: new SqliteToolSpecRepo(database)
  };
}
