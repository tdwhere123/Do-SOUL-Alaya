import { createHash } from "node:crypto";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { materializeEvidenceFactFrameFormation } from
  "../../memory/evidence-fact-frame-formation.js";

export const BOOKSHELF_ASSERTION = "I bought my bookshelf from IKEA.";

const BOOKSHELF_FACT_FRAME = Object.freeze({
  schema_version: 1 as const,
  slots: Object.freeze([
    Object.freeze({ role: "subject" as const, text: "I" }),
    Object.freeze({ role: "relation" as const, text: "bought" }),
    Object.freeze({ role: "value" as const, text: "my bookshelf" }),
    Object.freeze({ role: "qualifier" as const, text: "from IKEA" })
  ])
});

export function createVerifiedAssertionEvidence(input: Readonly<{
  readonly objectId?: string;
  readonly assertion?: string;
}> = {}): EvidenceCapsule {
  const assertion = input.assertion ?? BOOKSHELF_ASSERTION;
  const gist = `User: ${assertion}`;
  const sourceHash = formatVerifiedUserAssertionSourceHash(createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage({
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source_assertion: assertion,
      source_corpus: gist
    }), "utf8")
    .digest("hex"));
  return {
    object_id: input.objectId ?? "evidence-1",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "garden_compile",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: { topic: "bookshelf", keywords: [], summary: assertion },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist,
    excerpt: assertion,
    source_hash: sourceHash,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  };
}

export function materializeBookshelfFactFrame(sourceHash: string) {
  return materializeEvidenceFactFrameFormation({
    sourceAssertion: BOOKSHELF_ASSERTION,
    sourceHash,
    proposal: {
      schema_version: 1,
      producer_operator_id: "test_grounded_fact_frame_v1",
      source_assertion: BOOKSHELF_ASSERTION,
      fact_frame: BOOKSHELF_FACT_FRAME
    }
  }).capture;
}
