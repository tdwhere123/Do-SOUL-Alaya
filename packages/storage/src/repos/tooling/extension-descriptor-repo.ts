import {
  parseExtensionSkillPackage as parseProtocolExtensionSkillPackage,
  parseExtensionToolProvider as parseProtocolExtensionToolProvider,
  type SkillPackage,
  type ToolProvider
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { parseNonEmptyString } from "../shared/validators.js";

const TOOL_PROVIDER_DESCRIPTOR_TYPE = "tool_provider";
const SKILL_PACKAGE_DESCRIPTOR_TYPE = "skill_package";

interface ExtensionDescriptorRow {
  readonly descriptor_id: string;
  readonly descriptor_type: string;
  readonly name: string;
  readonly source: string;
  readonly metadata_json: string;
  readonly registered_at: string;
}

export interface ExtensionDescriptorRepo {
  registerToolProvider(provider: ToolProvider): Promise<Readonly<ToolProvider>>;
  deleteToolProvider(providerId: string): Promise<void>;
  registerSkillPackage(pkg: SkillPackage): Promise<Readonly<SkillPackage>>;
  findToolProviders(): Promise<readonly Readonly<ToolProvider>[]>;
  findToolProviderById(providerId: string): Promise<Readonly<ToolProvider> | null>;
}

export class SqliteExtensionDescriptorRepo implements ExtensionDescriptorRepo {
  private readonly upsertDescriptorStatement;
  private readonly deleteDescriptorStatement;
  private readonly listToolProvidersStatement;
  private readonly findDescriptorByIdStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.upsertDescriptorStatement = db.connection.prepare(`
      INSERT INTO extension_descriptors (
        descriptor_id,
        descriptor_type,
        name,
        source,
        metadata_json,
        registered_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(descriptor_id) DO UPDATE SET
        descriptor_type = excluded.descriptor_type,
        name = excluded.name,
        source = excluded.source,
        metadata_json = excluded.metadata_json,
        registered_at = excluded.registered_at
    `);

    this.deleteDescriptorStatement = db.connection.prepare(`
      DELETE FROM extension_descriptors
      WHERE descriptor_type = ?
        AND descriptor_id = ?
    `);

    this.listToolProvidersStatement = db.connection.prepare(`
      SELECT descriptor_id, descriptor_type, name, source, metadata_json, registered_at
      FROM extension_descriptors
      WHERE descriptor_type = ?
      ORDER BY registered_at ASC, descriptor_id ASC
    `);

    this.findDescriptorByIdStatement = db.connection.prepare(`
      SELECT descriptor_id, descriptor_type, name, source, metadata_json, registered_at
      FROM extension_descriptors
      WHERE descriptor_type = ?
        AND descriptor_id = ?
      LIMIT 1
    `);
  }

  public async registerToolProvider(provider: ToolProvider): Promise<Readonly<ToolProvider>> {
    const parsedProvider = parseToolProvider(provider);
    await this.upsertDescriptor(
      parsedProvider.provider_id,
      TOOL_PROVIDER_DESCRIPTOR_TYPE,
      parsedProvider.name,
      parsedProvider.source,
      parsedProvider.registered_at,
      parsedProvider
    );

    const persistedProvider = await this.findDescriptorById(
      TOOL_PROVIDER_DESCRIPTOR_TYPE,
      parsedProvider.provider_id
    );
    if (persistedProvider === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Persisted tool provider ${parsedProvider.provider_id} could not be reloaded.`
      );
    }

    return parseToolProviderRow(persistedProvider);
  }

  public async deleteToolProvider(providerId: string): Promise<void> {
    const parsedProviderId = parseNonEmptyString(providerId, "provider id");

    try {
      this.deleteDescriptorStatement.run(TOOL_PROVIDER_DESCRIPTOR_TYPE, parsedProviderId);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to delete tool provider ${parsedProviderId}.`,
        error
      );
    }
  }

  public async registerSkillPackage(pkg: SkillPackage): Promise<Readonly<SkillPackage>> {
    const parsedPackage = parseSkillPackage(pkg);
    await this.upsertDescriptor(
      parsedPackage.skill_id,
      SKILL_PACKAGE_DESCRIPTOR_TYPE,
      parsedPackage.name,
      parsedPackage.source,
      parsedPackage.registered_at,
      parsedPackage
    );

    const persistedPackage = await this.findDescriptorById(
      SKILL_PACKAGE_DESCRIPTOR_TYPE,
      parsedPackage.skill_id
    );
    if (persistedPackage === null) {
      throw new StorageError(
        "QUERY_FAILED",
        `Persisted skill package ${parsedPackage.skill_id} could not be reloaded.`
      );
    }

    return parseSkillPackageRow(persistedPackage);
  }

  public async findToolProviders(): Promise<readonly Readonly<ToolProvider>[]> {
    try {
      const rows = this.listToolProvidersStatement.all(
        TOOL_PROVIDER_DESCRIPTOR_TYPE
      ) as ExtensionDescriptorRow[];

      return rows.map((row) => parseToolProviderRow(row));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", "Failed to load tool providers.", error);
    }
  }

  public async findToolProviderById(
    providerId: string
  ): Promise<Readonly<ToolProvider> | null> {
    const parsedProviderId = parseNonEmptyString(providerId, "provider id");

    try {
      const row = await this.findDescriptorById(
        TOOL_PROVIDER_DESCRIPTOR_TYPE,
        parsedProviderId
      );

      return row === null ? null : parseToolProviderRow(row);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load tool provider ${parsedProviderId}.`,
        error
      );
    }
  }

  private async upsertDescriptor(
    descriptorId: string,
    descriptorType: string,
    name: string,
    source: string,
    registeredAt: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    try {
      this.upsertDescriptorStatement.run(
        descriptorId,
        descriptorType,
        name,
        source,
        JSON.stringify(metadata),
        registeredAt
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to persist extension descriptor ${descriptorId}.`,
        error
      );
    }
  }

  private async findDescriptorById(
    descriptorType: string,
    descriptorId: string
  ): Promise<ExtensionDescriptorRow | null> {
    try {
      const row = this.findDescriptorByIdStatement.get(
        descriptorType,
        descriptorId
      ) as ExtensionDescriptorRow | undefined;

      return row ?? null;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load extension descriptor ${descriptorId}.`,
        error
      );
    }
  }
}

function parseToolProvider(value: unknown): Readonly<ToolProvider> {
  try {
    return parseProtocolExtensionToolProvider(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate tool provider.", error);
  }
}

function parseSkillPackage(value: unknown): Readonly<SkillPackage> {
  try {
    return parseProtocolExtensionSkillPackage(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate skill package.", error);
  }
}

function parseToolProviderRow(row: ExtensionDescriptorRow): Readonly<ToolProvider> {
  if (row.descriptor_type !== TOOL_PROVIDER_DESCRIPTOR_TYPE) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Unexpected descriptor_type "${row.descriptor_type}" for tool provider row.`
    );
  }

  const metadata = parseDescriptorMetadata(row.metadata_json);
  const parsed = parseToolProvider(metadata);

  if (parsed.provider_id !== row.descriptor_id) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Descriptor id mismatch for tool provider ${row.descriptor_id}.`
    );
  }

  return parsed;
}

function parseSkillPackageRow(row: ExtensionDescriptorRow): Readonly<SkillPackage> {
  if (row.descriptor_type !== SKILL_PACKAGE_DESCRIPTOR_TYPE) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Unexpected descriptor_type "${row.descriptor_type}" for skill package row.`
    );
  }

  const metadata = parseDescriptorMetadata(row.metadata_json);
  const parsed = parseSkillPackage(metadata);

  if (parsed.skill_id !== row.descriptor_id) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Descriptor id mismatch for skill package ${row.descriptor_id}.`
    );
  }

  return parsed;
}

function parseDescriptorMetadata(value: string): unknown {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("descriptor metadata must be an object");
    }
    return parsed;
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse extension descriptor metadata.", error);
  }
}
