import { describe, expect, it } from "vitest";
import { LexicalBoundProofDiagnosticsSchema } from
  "../../../harness/recall/capture/capture-proof-diagnostics-schema.js";
import {
  capturedTruncatedProof,
  sealLexicalProof
} from "./capture-proof-diagnostics-fixture.js";

const REQUEST = `sha256:${"a".repeat(64)}`;
const SNAPSHOT = `sha256:${"b".repeat(64)}`;

describe("lexical bound snapshot diagnostics schema", () => {
  it("accepts a sealed snapshot distinct from the request digest", () => {
    const proof = withIdentity({
      request_digest: REQUEST,
      workspace_id: "workspace-1",
      snapshot_digest: SNAPSHOT
    });
    expect(LexicalBoundProofDiagnosticsSchema.parse(proof)).toEqual(proof);
    expect(proof.identity.snapshot_digest).toBe(SNAPSHOT);
    expect(proof.identity.request_digest).not.toBe(SNAPSHOT);
    expect(proof.evaluated_universe).toEqual({
      status: "unavailable",
      reason: "candidate_universe_not_proved"
    });
  });

  it("keeps snapshot_not_sealed artifacts compatible", () => {
    const proof = capturedTruncatedProof();
    expect(LexicalBoundProofDiagnosticsSchema.parse(proof)).toEqual(proof);
    expect(proof.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
  });

  it("rejects invalid snapshot syntax and a snapshot cloned from the request digest", () => {
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(withIdentity({
      request_digest: REQUEST,
      workspace_id: "workspace-1",
      snapshot_digest: `SHA256:${"b".repeat(64)}`
    })).success).toBe(false);
    expect(LexicalBoundProofDiagnosticsSchema.safeParse(withIdentity({
      request_digest: REQUEST,
      workspace_id: "workspace-1",
      snapshot_digest: REQUEST
    })).success).toBe(false);
  });
});

function withIdentity(identity: {
  readonly request_digest: string;
  readonly workspace_id: string;
  readonly snapshot_digest: string;
}) {
  const { proof_digest: _digest, ...body } = capturedTruncatedProof();
  return sealLexicalProof({ ...body, identity });
}
