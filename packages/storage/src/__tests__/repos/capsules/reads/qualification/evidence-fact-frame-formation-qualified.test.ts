import { createHash } from "node:crypto";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  buildAssociativeFactKeyProjections,
  evidenceFactFrameFormationCapturePreimage,
  type AssociativeFactFrame,
  type EvidenceCapsule,
  type EvidenceFactFrameFormationCapture,
  type EvidenceFactFrameFormationCaptureBody
} from "@do-soul/alaya-protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "../../evidence-capsule-repo-fixture.js";
import { ownerMatch } from "../../assistant-observation-qualified-fixture.js";
import {
  assertionCapsule,
  persistAssertionProof
} from "./verified-assertion-qualification-fixture.js";

const FACT_FRAME = Object.freeze({
  schema_version: 1 as const,
  slots: Object.freeze([
    Object.freeze({ role: "subject" as const, text: "I" }),
    Object.freeze({ role: "relation" as const, text: "bought" }),
    Object.freeze({ role: "value" as const, text: "my bookshelf" }),
    Object.freeze({ role: "qualifier" as const, text: "from IKEA" })
  ])
}) satisfies Readonly<AssociativeFactFrame>;

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) database.close();
  evidenceCapsuleDatabases.clear();
});

describe("qualified evidence fact-frame formation receipts", () => {
  it("returns the stored formed capture on owner reads", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const factFrame = formedCapture(capsule);
    await repo.create(
      capsule,
      buildAssociativeFactKeyProjections(FACT_FRAME),
      factFrame
    );
    await persistAssertionProof(database, capsule);

    await expect(repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    )).resolves.toEqual([{
      capsule,
      verified_user_projection: false,
      fact_frame_formation: factFrame
    }]);
  });

  it("keeps an unavailable capture unavailable without reconstructing slots", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const unavailable = unavailableCapture(capsule);
    await repo.create(capsule, [], unavailable);
    await persistAssertionProof(database, capsule);

    const [qualified] = await repo.findRecallQualifiedByIds(
      "workspace-1",
      [ownerMatch(capsule.object_id)]
    );
    expect(qualified?.fact_frame_formation).toEqual(unavailable);
    expect(qualified?.fact_frame_formation?.status).toBe("unavailable");
    expect(qualified?.fact_frame_formation?.producer_operator_id).toBeNull();
    expect(qualified?.fact_frame_formation?.fact_frame).toBeNull();
    expect(qualified?.matched_fact_frame).toBeUndefined();
    expect(JSON.stringify(qualified?.fact_frame_formation)).not.toContain("bought");
  });

  it("preserves producer, slots, and capture on a fact-key read", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    const capsule = assertionCapsule("aaaaaaaa-cccc-4ccc-8ccc-cccccccccccc");
    const factFrame = formedCapture(capsule);
    await repo.create(
      capsule,
      buildAssociativeFactKeyProjections(FACT_FRAME),
      factFrame
    );
    await persistAssertionProof(database, capsule);

    const [qualified] = await repo.findRecallQualifiedByIds("workspace-1", [{
      object_id: capsule.object_id,
      matched_projection: { projection_id: 5, projection_kind: "fact_key" }
    }]);
    expect(qualified?.fact_frame_formation).toEqual(factFrame);
    expect(qualified?.fact_frame_formation?.producer_operator_id)
      .toBe("test_grounded_fact_frame_v1");
    expect(qualified?.matched_fact_frame).toEqual(FACT_FRAME);
  });
});

function formedCapture(
  capsule: Readonly<EvidenceCapsule>
): EvidenceFactFrameFormationCapture {
  return digestCapture({
    schema_version: 1,
    operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "formed",
    producer_operator_id: "test_grounded_fact_frame_v1",
    source_hash: capsule.source_hash,
    fact_frame: FACT_FRAME
  });
}

function unavailableCapture(
  capsule: Readonly<EvidenceCapsule>
): EvidenceFactFrameFormationCapture {
  return digestCapture({
    schema_version: 1,
    operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
    status: "unavailable",
    producer_operator_id: null,
    source_hash: capsule.source_hash,
    fact_frame: null
  });
}

function digestCapture(
  body: Readonly<EvidenceFactFrameFormationCaptureBody>
): EvidenceFactFrameFormationCapture {
  return {
    ...body,
    capture_digest: `sha256:${createHash("sha256")
      .update(evidenceFactFrameFormationCapturePreimage(body), "utf8")
      .digest("hex")}`
  };
}
