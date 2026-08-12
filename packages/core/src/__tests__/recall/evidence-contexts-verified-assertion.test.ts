import { createHash } from "node:crypto";
import {
  EvidenceCapsuleSchema,
  buildVerifiedUserAssertionReceiptV2Preimage,
  formatVerifiedUserAssertionV2SourceHash,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import { describe, expect, it, vi } from "vitest";
import { collectRecallEvidenceContexts } from
  "../../recall/supplements/evidence/evidence-contexts.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const ASSERTION = "I bought my bookshelf from IKEA.";

describe("recall verified assertion context authority", () => {
  it("projects a v2 assertion only after Storage qualifies its owner", async () => {
    const evidence = createV2Evidence();
    const entry = createMemoryEntry({
      content: ASSERTION,
      evidence_refs: [evidence.object_id]
    });

    const contexts = await collectContexts(evidence, entry, true);

    expect(contexts.verifiedUserAssertionContextsByMemoryId[entry.object_id])
      .toEqual({
        schema_version: 1,
        source_role: "user",
        evidence_ref: evidence.object_id,
        assertion_text: ASSERTION,
        user_context: ASSERTION
      });
    expect(contexts.evidenceSemanticDocumentsByMemoryId[entry.object_id])
      .toEqual([expect.objectContaining({
        documentIdentity: "owner_gist_600",
        content: evidence.gist
      })]);
  });

  it("does not derive authority from an unqualified v2 capsule", async () => {
    const evidence = createV2Evidence();
    const entry = createMemoryEntry({
      content: ASSERTION,
      evidence_refs: [evidence.object_id]
    });

    const contexts = await collectContexts(evidence, entry, false);

    expect(contexts.verifiedUserAssertionContextsByMemoryId).toEqual({});
    expect(contexts.evidenceSemanticDocumentsByMemoryId).toEqual({});
  });
});

async function collectContexts(
  evidence: Readonly<EvidenceCapsule>,
  entry: ReturnType<typeof createMemoryEntry>,
  qualified: boolean
) {
  return await collectRecallEvidenceContexts({
    dependencies: {
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds: vi.fn(async () => [evidence]),
        findRecallQualifiedByIds: vi.fn(async () => qualified ? [{
          capsule: evidence,
          verified_user_projection: false
        }] : [])
      }
    },
    warn: vi.fn(),
    workspaceId: "workspace-1",
    candidates: [entry],
    coarseEvidenceFtsRanks: {},
    coarseEvidenceFtsRanksPerRef: {}
  });
}

function createV2Evidence(): EvidenceCapsule {
  const sourceCorpus = `User: ${ASSERTION}`;
  const digest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptV2Preimage({
      signal_id: "signal-1",
      source_locator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: 1
      },
      workspace_id: "workspace-1",
      run_id: "run-1",
      surface_id: null,
      source_assertion: ASSERTION,
      source_corpus: sourceCorpus
    }), "utf8")
    .digest("hex");
  return EvidenceCapsuleSchema.parse({
    object_id: "00000000-0000-4000-8000-000000000201",
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
    created_by: "garden_compile",
    lifecycle_state: "active",
    evidence_kind: "conversation_excerpt",
    semantic_anchor: {
      topic: "bookshelf",
      keywords: ["bookshelf", "IKEA"],
      summary: ASSERTION
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: sourceCorpus,
    excerpt: ASSERTION,
    source_hash: formatVerifiedUserAssertionV2SourceHash(digest),
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  });
}
