import { canonicalJson, type EvidenceCapsule, type FieldContractSha256 } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { uuidFromHex } from "./source-observation-identity.js";

/** Omitted workspace derives the frozen legacy key for explicit scoped compatibility reads only. */
export function semanticInterpretationEvidenceId(interpretationId: string, sha256: FieldContractSha256, workspaceId?: string): string {
  if (workspaceId !== undefined && workspaceId.trim().length === 0) throw new CoreError("VALIDATION", "workspace required for interpretation key");
  return uuidFromHex(sha256(workspaceId === undefined ? `source-semantic-interpretation:${interpretationId}`
    : canonicalJson({ contract: "workspace-source-semantic-interpretation-v1", workspace_id: workspaceId, interpretation_id: interpretationId })));
}

export function sourceSemanticCapsuleKeys(interpretationId: string, sha256: FieldContractSha256, workspaceId: string): readonly string[] {
  return [semanticInterpretationEvidenceId(interpretationId, sha256, workspaceId),
    semanticInterpretationEvidenceId(interpretationId, sha256)];
}

/** Legacy keys remain read-compatible until explicitly retired, with no ambiguous winner. */
export function selectSourceSemanticCapsule(rows: readonly (Readonly<EvidenceCapsule> | null)[], workspaceId: string): Readonly<EvidenceCapsule> | null {
  const found = rows.filter((row): row is Readonly<EvidenceCapsule> => row !== null && row.workspace_id === workspaceId);
  if (found.length > 1) throw new CoreError("CONFLICT", "ambiguous workspace interpretation capsules");
  return found[0] ?? null;
}
