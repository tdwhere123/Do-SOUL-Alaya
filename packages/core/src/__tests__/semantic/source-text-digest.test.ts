import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  sourceTextDigest as protocolDigest,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { materializeOpenSemanticFactorFormation } from "../../semantic/open-semantic-factor-formation.js";
import { prepareSemanticFactorFormationInsert } from
  "../../../../storage/src/repos/capsules/writes/semantic-factor-formation/capture-store.js";
import { readStoredSemanticFactorFormation } from
  "../../../../storage/src/repos/capsules/reads/qualification/semantic-factor-formation-read.js";

describe("sourceTextDigest", () => {
  it("is the protocol authority at core and storage call sites", () => {
    const source = "source corpus";
    const expected = protocolDigest(source, sha256);
    expect(expected).toBe(`sha256:${sha256(source)}`);

    const coreCapture = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: source,
      negative_status: "ineligible"
    });
    expect(coreCapture.source_sha256).toBe(expected);

    // Digest check only needs object_id / excerpt; cast avoids a full capsule fixture.
    const capsule = {
      object_id: "evidence-1",
      workspace_id: "ws-1",
      excerpt: source
    } as unknown as Readonly<EvidenceCapsule>;
    const capture = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: source,
      negative_status: "ineligible"
    });
    expect(prepareSemanticFactorFormationInsert(capsule, capture)).not.toBeNull();

    const row = {
      semantic_formation_workspace_id: "ws-1",
      semantic_formation_schema_version: capture.schema_version,
      semantic_formation_operator_id: capture.operator_id,
      semantic_formation_status: capture.status,
      semantic_formation_producer_operator_id: capture.producer_operator_id,
      semantic_formation_source_sha256: capture.source_sha256,
      semantic_formation_graph_json: null,
      semantic_formation_capture_digest: capture.capture_digest,
      semantic_completeness_json: null
    };
    expect(readStoredSemanticFactorFormation(row, "ws-1", source, undefined)?.source_sha256)
      .toBe(expected);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
