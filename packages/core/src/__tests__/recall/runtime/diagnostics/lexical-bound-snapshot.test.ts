import { describe, expect, it } from "vitest";
import {
  freezeLexicalBoundProof,
  sealLexicalBoundProof,
  verifyLexicalBoundProof
} from "../../../../recall/runtime/diagnostics/lexical-bound-proof.js";
import { truncatedReceipt } from "./lexical-bound-proof-fixture.js";

const REQUEST = `sha256:${"a".repeat(64)}`;
const SNAPSHOT = `sha256:${"b".repeat(64)}`;

describe("lexical bound snapshot identity", () => {
  it("leaves snapshot unsealed when the digest is omitted", () => {
    const sealed = sealCaptured({ request_digest: REQUEST, workspace_id: "workspace-1" });
    expect(sealed.identity.snapshot_digest).toEqual({
      status: "unavailable",
      reason: "snapshot_not_sealed"
    });
    expect(sealed.evaluated_universe).toEqual({
      status: "unavailable",
      reason: "candidate_universe_not_proved"
    });
    verifyLexicalBoundProof(sealed);
  });

  it("seals a distinct snapshot digest and round-trips through archive freeze", () => {
    const sealed = sealCaptured({
      request_digest: REQUEST,
      workspace_id: "workspace-1",
      snapshot_digest: SNAPSHOT
    });
    expect(sealed.identity.snapshot_digest).toBe(SNAPSHOT);
    expect(sealed.identity.request_digest).toBe(REQUEST);
    expect(sealed.identity.snapshot_digest).not.toBe(sealed.identity.request_digest);
    expect(sealed.evaluated_universe.reason).toBe("candidate_universe_not_proved");
    verifyLexicalBoundProof(sealed);
    const archived = freezeLexicalBoundProof(JSON.parse(JSON.stringify(sealed)));
    expect(archived).toEqual(sealed);
    if (archived === undefined) throw new Error("expected archived proof");
    verifyLexicalBoundProof(archived);
  });

  it("rejects invalid snapshot syntax and a snapshot cloned from the request digest", () => {
    const proof = freezeCaptured();
    expect(() => sealLexicalBoundProof(proof, { snapshot_digest: "not-a-digest" }))
      .toThrow(/digest identity is invalid/i);
    expect(() => sealLexicalBoundProof(proof, {
      request_digest: REQUEST,
      snapshot_digest: REQUEST
    })).toThrow(/must not equal request digest/i);
    expect(() => freezeLexicalBoundProof({
      ...sealCaptured({
        request_digest: REQUEST,
        workspace_id: "workspace-1",
        snapshot_digest: SNAPSHOT
      }),
      identity: {
        request_digest: REQUEST,
        workspace_id: "workspace-1",
        snapshot_digest: REQUEST
      }
    })).toThrow(/must not equal request digest/i);
  });
});

function freezeCaptured() {
  const proof = freezeLexicalBoundProof(truncatedReceipt());
  if (proof === undefined || proof.status !== "captured") {
    throw new Error("expected captured proof");
  }
  return proof;
}

function sealCaptured(seal: {
  readonly request_digest?: string;
  readonly workspace_id?: string;
  readonly snapshot_digest?: string;
}) {
  const sealed = sealLexicalBoundProof(freezeCaptured(), seal);
  if (sealed.status !== "captured") throw new Error("expected captured proof");
  return sealed;
}
