import { readdirSync } from "node:fs";
import {
  readBoundedCanonicalUtf8Artifact,
  withRootBoundDirectory
} from "../cache-audit/bounded-artifact-reader.js";
import {
  MAX_SEMANTIC_FILL_ATTEMPT_BYTES,
  assertSemanticFillAttemptEvidence,
  type SemanticFillDurableAttemptEvidence
} from "./semantic-fill-attempt-evidence.js";
export type { SemanticFillDurableAttemptEvidence } from
  "./semantic-fill-attempt-evidence.js";

const PRIVATE_ROOT = ".semantic-fill-private";
const ATTEMPT_ROOT = "attempts";

export function readSemanticFillAttemptEvidence(
  root: string
): readonly SemanticFillDurableAttemptEvidence[] {
  try {
    return withRootBoundDirectory({
      root, segments: [PRIVATE_ROOT, ATTEMPT_ROOT], label: "semantic fill private attempts"
    }, (attemptRoot) => {
      const records: SemanticFillDurableAttemptEvidence[] = [];
      for (const scope of readdirSync(attemptRoot, { withFileTypes: true })) {
        if (!scope.isDirectory() || scope.isSymbolicLink() || !isDigest(scope.name)) {
          throw new Error("semantic fill private attempt root contains a foreign entry");
        }
        withRootBoundDirectory({
          root: attemptRoot, segments: [scope.name], label: "semantic fill attempt scope"
        }, (directory) => records.push(...readAttemptRecords(directory, scope.name).values()));
      }
      return Object.freeze(records.sort((left, right) =>
        left.scopeIdentity.localeCompare(right.scopeIdentity) || left.ordinal - right.ordinal));
    });
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return [];
    throw cause;
  }
}

function readAttemptRecords(
  directory: string,
  scopeIdentity: string
): Map<number, SemanticFillDurableAttemptEvidence> {
  const records = new Map<number, SemanticFillDurableAttemptEvidence>();
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "ledger.json") continue;
    const matched = /^attempt-(\d{12})\.json$/u.exec(entry.name);
    if (!entry.isFile() || entry.isSymbolicLink() || matched === null) {
      throw new Error("semantic fill attempt scope contains a foreign entry");
    }
    const parsed = JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: `${directory}/${entry.name}`,
      maxBytes: MAX_SEMANTIC_FILL_ATTEMPT_BYTES,
      label: "semantic fill durable attempt evidence"
    })) as SemanticFillDurableAttemptEvidence;
    assertSemanticFillAttemptEvidence(parsed, scopeIdentity);
    if (Number(matched[1]) !== parsed.ordinal || records.has(parsed.ordinal)) {
      throw new Error("semantic fill attempt ordinal path mismatch");
    }
    records.set(parsed.ordinal, parsed);
  }
  const ordinals = [...records.keys()].sort((left, right) => left - right);
  if (ordinals.some((ordinal, index) => ordinal !== index + 1)) {
    throw new Error("semantic fill durable attempt ordinals are not contiguous");
  }
  return new Map(ordinals.map((ordinal) => [ordinal, records.get(ordinal)!]));
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function hasCode(cause: unknown, code: string): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && cause.code === code;
}
