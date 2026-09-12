import { readBoundedCanonicalUtf8Artifact } from "../../runs/extraction/cache-audit/bounded-artifact-reader.js";
import type { GeminiBatchLimits, GeminiBatchOperation } from "../../runs/extraction/fill/batch/contract.js";
import { matchFlagToken, nextIndex, parsePositiveInt, readRequiredFlagValue } from "../options/flag-values.js";

export interface ExtractionBatchOptions {
  readonly window?: string;
  readonly requestLimit?: number;
  readonly operation: GeminiBatchOperation;
  readonly limits: GeminiBatchLimits;
  readonly reconcile?: { readonly localJob: string; readonly remoteJob: string };
}

export function peelExtractionBatchFlags(args: readonly string[]): {
  readonly rest: readonly string[];
  readonly batch?: ExtractionBatchOptions;
} {
  const flags = ["--batch-operation", "--batch-limits", "--batch-window", "--batch-request-limit", "--batch-local-job", "--batch-remote-job"];
  const values = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    const flag = flags.find((name) => matchFlagToken(token, name));
    if (flag === undefined) { rest.push(token); continue; }
    if (values.has(flag)) throw new Error(`${flag} may be provided only once`);
    values.set(flag, readRequiredFlagValue(args, index, token, flag, `${flag} requires a value`));
    index = nextIndex(index, token);
  }
  if (values.size === 0) return { rest };
  const operation = values.get("--batch-operation");
  const path = values.get("--batch-limits");
  if (!operation || !["prepare", "submit", "status", "resume", "import", "cancel"].includes(operation) || !path) {
    throw new Error("Batch requires --batch-operation prepare|submit|status|resume|import|cancel and --batch-limits <json>");
  }
  const localJob = values.get("--batch-local-job");
  const window = values.get("--batch-window");
  const requestLimit = parsePositiveInt(values.get("--batch-request-limit"), "--batch-request-limit");
  if (window !== undefined && !/^[a-zA-Z0-9_-]{1,64}$/u.test(window)) throw new Error("invalid Batch window name");
  const remoteJob = values.get("--batch-remote-job");
  if ((localJob === undefined) !== (remoteJob === undefined)) throw new Error("Batch reconciliation requires both job identities");
  const limits = JSON.parse(readBoundedCanonicalUtf8Artifact({ path, maxBytes: 16_384, label: "Batch limits" })) as GeminiBatchLimits;
  return { rest, batch: {
    operation: operation as GeminiBatchOperation, limits,
    ...(window === undefined ? {} : { window }),
    ...(requestLimit === undefined ? {} : { requestLimit }),
    ...(localJob === undefined ? {} : { reconcile: { localJob, remoteJob: remoteJob! } })
  } };
}
