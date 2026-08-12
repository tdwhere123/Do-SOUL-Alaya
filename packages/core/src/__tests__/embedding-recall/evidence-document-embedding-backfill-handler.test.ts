import { describe, expect, it, vi } from "vitest";
import {
  EvidenceDocumentEmbeddingBackfillHandler
} from "../../embedding-recall/evidence/evidence-document-embedding-backfill-handler.js";
import type {
  EmbeddingProviderPort,
  EvidenceDocumentEmbeddingRecord,
  EvidenceDocumentEmbeddingRepoPort,
  EvidenceDocumentEmbeddingSource
} from "../../embedding-recall/types.js";

const SOURCE_HASH = `sha256:garden-source-turn-fallback-v2:${"a".repeat(64)}`;
const ASSERTION_SOURCE_HASH = `sha256:garden-verified-user-assertion-v2:${"b".repeat(64)}`;

describe("EvidenceDocumentEmbeddingBackfillHandler", () => {
  it("persists exact bounded recall documents once and skips non-authoritative sources", async () => {
    const records: EvidenceDocumentEmbeddingRecord[] = [];
    const repo = createRepo([
      source({ documentIdentity: "owner", content: `  ${"x".repeat(650)}  ` }),
      source({ documentIdentity: "owner_gist_600", content: "Whole turn." }),
      source({
        documentIdentity: "assistant_observation:2",
        content: "Assistant observation."
      }),
      source({ ownerObjectId: "evidence-duplicate", content: "Same bounded text." }),
      source({
        ownerObjectId: "evidence-duplicate",
        documentIdentity: "owner_gist_600",
        content: "  Same bounded text.  "
      }),
      source({
        ownerObjectId: "evidence-assertion",
        documentIdentity: "fact_key:1",
        content: "recommended_color=blue",
        sourceHash: ASSERTION_SOURCE_HASH
      }),
      source({
        ownerObjectId: "evidence-forged-assertion",
        documentIdentity: "fact_key:1",
        content: "Must not be embedded.",
        sourceHash: "sha256:unknown-receipt"
      }),
      source({
        ownerObjectId: "evidence-untrusted",
        createdBy: "user",
        content: "Must not be embedded."
      })
    ], records);
    const embedTexts = vi.fn(async (texts: readonly string[]) =>
      texts.map((text) => new Float32Array([text.length, 1]))
    );
    const handler = new EvidenceDocumentEmbeddingBackfillHandler({
      evidenceDocumentEmbeddingRepo: repo,
      provider: provider(embedTexts),
      now: () => "2026-07-28T00:00:00.000Z"
    });

    const first = await handler.handle({ workspace_id: "workspace-1" });
    const second = await handler.handle({ workspace_id: "workspace-1" });

    expect(first.documentsAffected).toBe(5);
    expect(second.documentsAffected).toBe(0);
    expect(embedTexts).toHaveBeenCalledOnce();
    expect(embedTexts).toHaveBeenCalledWith([
      `${"x".repeat(600)}…`,
      "Whole turn.",
      "Assistant observation.",
      "Same bounded text.",
      "recommended_color=blue"
    ], { timeoutMs: 10_000 });
    expect(records.map(({ documentIdentity }) => documentIdentity)).toEqual([
      "owner",
      "owner_gist_600",
      "assistant_observation:2",
      "owner",
      "fact_key:1"
    ]);
  });

  it("does no storage work while the provider is unavailable", async () => {
    const repo = createRepo([source()], []);
    const handler = new EvidenceDocumentEmbeddingBackfillHandler({
      evidenceDocumentEmbeddingRepo: repo,
      provider: { ...provider(vi.fn()), isAvailable: false }
    });

    await expect(handler.handle({ workspace_id: "workspace-1" })).resolves.toEqual({
      documentsAffected: 0,
      auditEntries: ["evidence_embedding_backfill_skipped:provider_unavailable"]
    });
    expect(repo.listSourcesByWorkspace).not.toHaveBeenCalled();
  });

  it("fails loudly when a cold batch cannot be persisted", async () => {
    const repo = createRepo([source()], []);
    repo.upsertMany.mockRejectedValueOnce(new Error("disk unavailable"));
    const handler = new EvidenceDocumentEmbeddingBackfillHandler({
      evidenceDocumentEmbeddingRepo: repo,
      provider: provider(async () => [new Float32Array([1, 2])])
    });

    await expect(handler.handle({ workspace_id: "workspace-1" }))
      .rejects.toThrow("could not persist");
  });
});

function source(
  overrides: Partial<EvidenceDocumentEmbeddingSource> = {}
): EvidenceDocumentEmbeddingSource {
  return {
    workspaceId: "workspace-1",
    ownerObjectId: "evidence-1",
    documentIdentity: "owner",
    content: "User-owned excerpt.",
    lifecycleState: "active",
    createdBy: "garden_compile",
    evidenceKind: "conversation_excerpt",
    evidenceHealthState: "verified",
    artifactRef: "alaya:garden-turn-evidence:signal-1",
    sourceHash: SOURCE_HASH,
    ...overrides
  };
}

function provider(
  embedTexts: EmbeddingProviderPort["embedTexts"]
): EmbeddingProviderPort {
  return {
    providerKind: "local_onnx",
    modelId: "fixture-model",
    schemaVersion: 1,
    isAvailable: true,
    embedTexts
  };
}

function createRepo(
  sources: readonly EvidenceDocumentEmbeddingSource[],
  records: EvidenceDocumentEmbeddingRecord[]
): EvidenceDocumentEmbeddingRepoPort & {
  readonly listSourcesByWorkspace: ReturnType<typeof vi.fn>;
} {
  return {
    listSourcesByWorkspace: vi.fn(async () => sources),
    findByDocuments: vi.fn(async (input) => records.filter((record) =>
      record.workspaceId === input.workspaceId &&
      record.providerKind === input.providerKind &&
      record.modelId === input.modelId &&
      record.schemaVersion === input.schemaVersion &&
      input.documents.some((document) =>
        document.ownerObjectId === record.ownerObjectId &&
        document.documentIdentity === record.documentIdentity &&
        document.contentHash === record.contentHash
      )
    )),
    upsertMany: vi.fn(async (incoming) => {
      for (const record of incoming) {
        const index = records.findIndex((candidate) =>
          candidate.workspaceId === record.workspaceId &&
          candidate.ownerObjectId === record.ownerObjectId &&
          candidate.documentIdentity === record.documentIdentity
        );
        if (index < 0) records.push(record);
        else records[index] = record;
      }
    })
  };
}
