import { isDeepStrictEqual } from "node:util";
import type { ExtractionFillManifestContract } from "./fill-manifest-contract.js";
import {
  LongMemEvalExpansionLineageSchema,
  type LongMemEvalExpansionLineage
} from "../promotion/expansion-lineage-schema.js";
import {
  LongMemEvalExpansionSourceAnchorSchema,
  type LongMemEvalExpansionSourceAnchor
} from "../promotion/expansion-source-anchor-schema.js";

export interface ExpansionManifestArtifacts {
  readonly expansion_source_anchor?: LongMemEvalExpansionSourceAnchor;
  readonly expansion_lineage?: LongMemEvalExpansionLineage;
}

export function parseExpansionManifestArtifacts(input: {
  readonly record: Readonly<Record<string, unknown>>;
  readonly schemaVersion: 1 | 2 | 3;
  readonly fill: ExtractionFillManifestContract;
  readonly filePath: string;
}): ExpansionManifestArtifacts {
  const { record, schemaVersion, filePath } = input;
  if (schemaVersion !== 3) {
    assertLegacyArtifactsAbsent(record, schemaVersion, filePath);
    return {};
  }
  const anchor = parseArtifact(
    record.expansion_source_anchor,
    LongMemEvalExpansionSourceAnchorSchema,
    "source anchor",
    filePath
  );
  const lineage = parseArtifact(
    record.expansion_lineage,
    LongMemEvalExpansionLineageSchema,
    "lineage",
    filePath
  );
  assertExpansionWindow(input.fill, anchor, lineage, filePath);
  if (anchor !== undefined && lineage !== undefined) {
    assertAnchorLineageBinding(anchor, lineage, filePath);
  }
  return {
    ...(anchor === undefined ? {} : { expansion_source_anchor: anchor }),
    ...(lineage === undefined ? {} : { expansion_lineage: lineage })
  };
}

function parseArtifact<T>(
  value: unknown,
  schema: { readonly parse: (candidate: unknown) => T },
  label: string,
  filePath: string
): T | undefined {
  if (value === undefined) return undefined;
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new Error(`extraction cache manifest at ${filePath} has invalid ${label}`, {
      cause
    });
  }
}

function assertExpansionWindow(
  fill: ExtractionFillManifestContract,
  anchor: LongMemEvalExpansionSourceAnchor | undefined,
  lineage: LongMemEvalExpansionLineage | undefined,
  filePath: string
): void {
  if (anchor === undefined && lineage === undefined) return;
  if (fill.window_offset !== 0 || fill.window_limit !== 500) {
    throw new Error(`extraction cache manifest at ${filePath} has expansion data outside 500Q`);
  }
  if (fill.fill_status === "in_progress" && anchor !== undefined &&
      lineage === undefined) return;
  if (fill.fill_status === "complete" && anchor !== undefined &&
      lineage !== undefined) return;
  throw new Error(`extraction cache manifest at ${filePath} has invalid expansion state`);
}

function assertAnchorLineageBinding(
  anchor: LongMemEvalExpansionSourceAnchor,
  lineage: LongMemEvalExpansionLineage,
  filePath: string
): void {
  const { schema_version: _as, kind: _ak, target_cache: anchorTarget, ...anchorBase } = anchor;
  const { schema_version: _ls, kind: _lk, target_cache: lineageTarget, ...lineageBase } = lineage;
  const { content_closure_sha256: _closure, ...lineageExpectation } = lineageTarget;
  if (isDeepStrictEqual(anchorBase, lineageBase) &&
      isDeepStrictEqual(anchorTarget, lineageExpectation)) return;
  throw new Error(`extraction cache manifest at ${filePath} has divergent expansion authority`);
}

function assertLegacyArtifactsAbsent(
  record: Readonly<Record<string, unknown>>,
  schemaVersion: 1 | 2,
  filePath: string
): void {
  if (record.expansion_source_anchor === undefined &&
      record.expansion_lineage === undefined) return;
  throw new Error(
    `extraction cache manifest at ${filePath} schema_version ${schemaVersion} ` +
      "must not define expansion authority"
  );
}
