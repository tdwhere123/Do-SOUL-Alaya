import { afterEach, describe, expect, it } from "vitest";
import type { SkillPackage, ToolProvider } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { SqliteExtensionDescriptorRepo } from "../../index.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

const validTimestamp = "2026-04-20T09:00:00.000Z";

function createToolProvider(overrides: Partial<ToolProvider> = {}): ToolProvider {
  return {
    provider_id: "provider.mcp.filesystem",
    name: "Filesystem MCP Provider",
    source: "mcp_external",
    tool_specs: [
      {
        tool_id: "mcp__filesystem__read_file",
        name: "filesystem.read_file",
        description: "Read file through filesystem MCP."
      },
      {
        tool_id: "mcp__filesystem__write_file",
        name: "filesystem.write_file",
        description: "Write file through filesystem MCP."
      }
    ],
    requires_permission_check: true,
    records_execution: true,
    registered_at: validTimestamp,
    ...overrides
  };
}

function createSkillPackage(overrides: Partial<SkillPackage> = {}): SkillPackage {
  return {
    skill_id: "skill.filesystem",
    name: "Filesystem Skill Package",
    version: "1.0.0",
    source: "skill_package",
    tool_ids: ["mcp__filesystem__read_file", "mcp__filesystem__write_file"],
    registered_at: validTimestamp,
    ...overrides
  };
}

describe("SqliteExtensionDescriptorRepo", () => {
  it("persists and lists tool providers with descriptor metadata", async () => {
    const { database, repo } = createRepo();
    const provider = createToolProvider();

    await expect(repo.registerToolProvider(provider)).resolves.toEqual(provider);
    await expect(repo.findToolProviders()).resolves.toEqual([provider]);
    await expect(repo.findToolProviderById(provider.provider_id)).resolves.toEqual(provider);

    const descriptorRow = database.connection
      .prepare(
        `SELECT descriptor_type, name, source, registered_at
         FROM extension_descriptors
         WHERE descriptor_id = ?`
      )
      .get(provider.provider_id) as
      | {
          readonly descriptor_type: string;
          readonly name: string;
          readonly source: string;
          readonly registered_at: string;
        }
      | undefined;

    expect(descriptorRow).toEqual({
      descriptor_type: "tool_provider",
      name: provider.name,
      source: provider.source,
      registered_at: provider.registered_at
    });
  });

  it("returns the persisted tool provider after registerToolProvider", async () => {
    const { database, repo } = createRepo();
    const provider = createToolProvider();
    const persistedProvider = createToolProvider({
      name: "Filesystem MCP Provider (Persisted)",
      registered_at: "2026-04-21T10:30:00.000Z"
    });

    database.connection.exec(`
      CREATE TRIGGER extension_descriptors_tool_provider_normalize_after_insert
      AFTER INSERT ON extension_descriptors
      WHEN NEW.descriptor_type = 'tool_provider'
      BEGIN
        UPDATE extension_descriptors
        SET name = 'Filesystem MCP Provider (Persisted)',
            registered_at = '2026-04-21T10:30:00.000Z',
            metadata_json = '${sqlStringLiteral(JSON.stringify(persistedProvider))}'
        WHERE descriptor_id = NEW.descriptor_id;
      END;
    `);

    await expect(repo.registerToolProvider(provider)).resolves.toEqual(persistedProvider);
    await expect(repo.findToolProviderById(provider.provider_id)).resolves.toEqual(persistedProvider);
  });

  it("upserts tool providers to support hot reload updates", async () => {
    const { repo } = createRepo();
    const initial = createToolProvider();
    const updated = createToolProvider({
      name: "Filesystem MCP Provider (Reloaded)",
      tool_specs: [
        ...initial.tool_specs,
        {
          tool_id: "mcp__filesystem__search_files",
          name: "filesystem.search_files",
          description: "Search files through filesystem MCP."
        }
      ]
    });

    await repo.registerToolProvider(initial);
    await repo.registerToolProvider(updated);

    await expect(repo.findToolProviders()).resolves.toEqual([updated]);
    await expect(repo.findToolProviderById(updated.provider_id)).resolves.toEqual(updated);
  });

  it("deletes tool providers by descriptor id for rollback compensation", async () => {
    const { repo } = createRepo();
    const provider = createToolProvider();

    await repo.registerToolProvider(provider);
    await repo.deleteToolProvider(provider.provider_id);

    await expect(repo.findToolProviderById(provider.provider_id)).resolves.toBeNull();
    await expect(repo.findToolProviders()).resolves.toEqual([]);
  });

  it("does not rescan unrelated descriptor rows after provider upsert", async () => {
    const { database, repo } = createRepo();

    database.connection
      .prepare(
        `INSERT INTO extension_descriptors (
           descriptor_id,
           descriptor_type,
           name,
           source,
           metadata_json,
           registered_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "provider.mcp.corrupted",
        "tool_provider",
        "Corrupted MCP Provider",
        "mcp_external",
        "{\"provider_id\":",
        validTimestamp
      );

    await expect(repo.registerToolProvider(createToolProvider())).resolves.toEqual(createToolProvider());
  });

  it("persists skill packages in extension_descriptors storage", async () => {
    const { database, repo } = createRepo();
    const skillPackage = createSkillPackage();

    await expect(repo.registerSkillPackage(skillPackage)).resolves.toEqual(skillPackage);

    const row = database.connection
      .prepare(
        `SELECT descriptor_type, name, source
         FROM extension_descriptors
         WHERE descriptor_id = ?`
      )
      .get(skillPackage.skill_id) as
      | {
          readonly descriptor_type: string;
          readonly name: string;
          readonly source: string;
        }
      | undefined;

    expect(row).toEqual({
      descriptor_type: "skill_package",
      name: skillPackage.name,
      source: skillPackage.source
    });
  });

  it("returns the persisted skill package after registerSkillPackage", async () => {
    const { database, repo } = createRepo();
    const skillPackage = createSkillPackage();
    const persistedSkillPackage = createSkillPackage({
      name: "Filesystem Skill Package (Persisted)",
      registered_at: "2026-04-21T11:00:00.000Z"
    });

    database.connection.exec(`
      CREATE TRIGGER extension_descriptors_skill_package_normalize_after_insert
      AFTER INSERT ON extension_descriptors
      WHEN NEW.descriptor_type = 'skill_package'
      BEGIN
        UPDATE extension_descriptors
        SET name = 'Filesystem Skill Package (Persisted)',
            registered_at = '2026-04-21T11:00:00.000Z',
            metadata_json = '${sqlStringLiteral(JSON.stringify(persistedSkillPackage))}'
        WHERE descriptor_id = NEW.descriptor_id;
      END;
    `);

    await expect(repo.registerSkillPackage(skillPackage)).resolves.toEqual(persistedSkillPackage);

    const row = database.connection
      .prepare(
        `SELECT metadata_json, registered_at
         FROM extension_descriptors
         WHERE descriptor_id = ?`
      )
      .get(skillPackage.skill_id) as
      | {
          readonly metadata_json: string;
          readonly registered_at: string;
        }
      | undefined;

    expect(row).toEqual({
      metadata_json: JSON.stringify(persistedSkillPackage),
      registered_at: persistedSkillPackage.registered_at
    });
  });

  it("rejects malformed descriptors before persistence", async () => {
    const { database, repo } = createRepo();
    const invalidProvider = {
      ...createToolProvider(),
      provider_id: ""
    } as unknown as ToolProvider;

    await expect(repo.registerToolProvider(invalidProvider)).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    } satisfies Pick<StorageError, "code">);

    const row = database.connection
      .prepare("SELECT descriptor_id FROM extension_descriptors WHERE descriptor_id = ?")
      .get(invalidProvider.provider_id);

    expect(row).toBeUndefined();
  });

  it("rejects persisted tool-provider rows whose metadata shape is not a valid provider", async () => {
    const { database, repo } = createRepo();

    database.connection
      .prepare(
        `INSERT INTO extension_descriptors (
           descriptor_id,
           descriptor_type,
           name,
           source,
           metadata_json,
           registered_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        "provider.mcp.filesystem",
        "tool_provider",
        "Filesystem MCP Provider",
        "mcp_external",
        JSON.stringify({
          provider_id: "provider.mcp.filesystem",
          name: "Filesystem MCP Provider",
          source: "mcp_external",
          tool_specs: "not-an-array",
          requires_permission_check: true,
          records_execution: true,
          registered_at: validTimestamp
        }),
        validTimestamp
      );

    await expect(repo.findToolProviders()).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    } satisfies Pick<StorageError, "code">);
  });
});

function createRepo(): {
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteExtensionDescriptorRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  return {
    database,
    repo: new SqliteExtensionDescriptorRepo(database)
  };
}

function sqlStringLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
