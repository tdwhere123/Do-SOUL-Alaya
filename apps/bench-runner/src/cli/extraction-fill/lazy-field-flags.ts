import {
  matchFlagToken,
  nextIndex,
  parseNonNegativeInt,
  readFlagValue,
  readRequiredFlagValue
} from "../options/flag-values.js";

export interface ExtractionFillLazyFlags {
  readonly ingestionMode?: "precomputed_full" | "lazy_field";
  readonly semanticArtifactRoot?: string;
  readonly semanticMaxCalls?: number;
  readonly semanticMaxFailures?: number;
}

export function peelExtractionFillLazyFlags(args: ReadonlyArray<string>): {
  readonly lazy: ExtractionFillLazyFlags;
  readonly rest: readonly string[];
} {
  assertFlagAtMostOnce(args, "--ingestion-mode");
  assertFlagAtMostOnce(args, "--semantic-artifact-root");
  assertFlagAtMostOnce(args, "--semantic-max-calls");
  assertFlagAtMostOnce(args, "--semantic-max-failures");
  const rest: string[] = [];
  const lazy: {
    ingestionMode?: "precomputed_full" | "lazy_field";
    semanticArtifactRoot?: string;
    semanticMaxCalls?: number;
    semanticMaxFailures?: number;
  } = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    const consumed = consumeLazyFieldFlag(args, index, token, lazy);
    if (consumed === undefined) {
      rest.push(token);
      continue;
    }
    index = consumed;
  }
  return { lazy, rest };
}

function consumeLazyFieldFlag(
  args: ReadonlyArray<string>,
  index: number,
  token: string,
  lazy: {
    ingestionMode?: "precomputed_full" | "lazy_field";
    semanticArtifactRoot?: string;
    semanticMaxCalls?: number;
    semanticMaxFailures?: number;
  }
): number | undefined {
  if (matchFlagToken(token, "--ingestion-mode")) {
    lazy.ingestionMode = parseIngestionMode(
      readRequiredFlagValue(
        args, index, token, "--ingestion-mode", "--ingestion-mode requires a value"
      )
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--semantic-artifact-root")) {
    lazy.semanticArtifactRoot = readRequiredFlagValue(
      args, index, token, "--semantic-artifact-root",
      "--semantic-artifact-root requires a path"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--semantic-max-calls")) {
    lazy.semanticMaxCalls = parseNonNegativeInt(
      readFlagValue(args, index, token, "--semantic-max-calls"), "--semantic-max-calls"
    );
    return nextIndex(index, token);
  }
  if (matchFlagToken(token, "--semantic-max-failures")) {
    lazy.semanticMaxFailures = parseNonNegativeInt(
      readFlagValue(args, index, token, "--semantic-max-failures"),
      "--semantic-max-failures"
    );
    return nextIndex(index, token);
  }
  return undefined;
}

function parseIngestionMode(raw: string): "precomputed_full" | "lazy_field" {
  if (raw !== "precomputed_full" && raw !== "lazy_field") {
    throw new Error("--ingestion-mode must be one of: precomputed_full, lazy_field");
  }
  return raw;
}

function assertFlagAtMostOnce(args: ReadonlyArray<string>, flag: string): void {
  const count = args.filter((token) => token === flag || token.startsWith(`${flag}=`)).length;
  if (count > 1) throw new Error(`${flag} may be provided only once`);
}
