import { PromptAssetSchema, type PromptAsset } from "@do-what/protocol";
import { CoreError } from "./errors.js";

const DEFAULT_MAX_PROMPT_ASSETS = 128;

export class PromptAssetRegistry {
  private readonly assets = new Map<string, Readonly<PromptAsset>>();
  private readonly maxAssets: number;

  public constructor(options: { readonly maxAssets?: number } = {}) {
    this.maxAssets = options.maxAssets ?? DEFAULT_MAX_PROMPT_ASSETS;
  }

  public register(asset: PromptAsset): void {
    const validated = parsePromptAsset(asset, getAssetIdForError(asset));
    const existing = this.assets.get(validated.asset_id);

    if (existing !== undefined && existing.immutable) {
      if (existing.content !== validated.content) {
        throw new CoreError(
          "CONFLICT",
          `Cannot modify immutable prompt asset: ${validated.asset_id}`
        );
      }
      return;
    }

    if (this.assets.size >= this.maxAssets) {
      throw new CoreError(
        "CONFLICT",
        `Prompt asset registry capacity exceeded (${this.maxAssets}).`
      );
    }

    this.assets.set(validated.asset_id, validated);
  }

  public updateOperational(assetId: string, content: string): void {
    const existing = this.assets.get(assetId);
    if (existing === undefined) {
      throw new CoreError("NOT_FOUND", `Prompt asset not found: ${assetId}`);
    }
    if (existing.immutable) {
      throw new CoreError("CONFLICT", `Cannot modify immutable prompt asset: ${assetId}`);
    }

    const updated = parsePromptAsset(
      {
        ...existing,
        content
      },
      assetId
    );

    this.assets.set(assetId, updated);
  }

  public assemble(): string {
    return [...this.assets.values()]
      .sort(compareAssets)
      .map((asset) => `## ${asset.label}\n${asset.content}`)
      .join("\n\n");
  }

  public list(): readonly Readonly<PromptAsset>[] {
    return Object.freeze([...this.assets.values()]);
  }

  public getById(assetId: string): Readonly<PromptAsset> | null {
    return this.assets.get(assetId) ?? null;
  }

  public getConstitutional(): readonly Readonly<PromptAsset>[] {
    return [...this.assets.values()].filter((asset) => asset.kind === "constitutional");
  }

  public stats(): Readonly<{ constitutional: number; operational: number }> {
    let constitutional = 0;
    let operational = 0;

    for (const asset of this.assets.values()) {
      if (asset.kind === "constitutional") {
        constitutional += 1;
      } else {
        operational += 1;
      }
    }

    return Object.freeze({ constitutional, operational });
  }
}

function compareAssets(left: PromptAsset, right: PromptAsset): number {
  if (left.kind !== right.kind) {
    return left.kind === "constitutional" ? -1 : 1;
  }
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  return left.asset_id.localeCompare(right.asset_id);
}

function isZodError(error: unknown): error is Error {
  return error instanceof Error && error.name === "ZodError";
}

function parsePromptAsset(asset: unknown, assetId: string): PromptAsset {
  try {
    return PromptAssetSchema.parse(asset);
  } catch (error) {
    if (isZodError(error)) {
      throw new CoreError("VALIDATION", `Prompt asset is invalid: ${assetId}`, {
        cause: error
      });
    }
    throw error;
  }
}

function getAssetIdForError(asset: unknown): string {
  if (typeof asset === "object" && asset !== null && "asset_id" in asset) {
    const candidate = (asset as { asset_id?: unknown }).asset_id;
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "<unknown>";
}
