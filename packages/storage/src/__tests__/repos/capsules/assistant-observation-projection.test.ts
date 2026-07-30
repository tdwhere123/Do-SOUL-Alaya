import { afterEach, describe, expect, it } from "vitest";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "./evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) database.close();
  evidenceCapsuleDatabases.clear();
});

describe("Assistant observation projection FTS", () => {
  it("keeps kind-local numeric identities when only one child matches", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const objectId = "1f5c2a90-0000-4000-8000-000000000011";
    const recommendation = "Choose the moss-green TrailShell pack; its roll-top keeps a laptop dry in rain. It also dries quickly overnight.";
    const userAssertion = "I commute by bicycle with cobalt panniers.";
    const capsule = createEvidenceCapsule({
      object_id: objectId,
      gist: `User: Which backpack should I use for a rainy commute?\nAssistant: ${recommendation}`,
      excerpt: "Which backpack should I use for a rainy commute?",
      source_hash: "sha256:garden-source-turn-fallback-v2:assistant-observation"
    });
    await repo.create(capsule, [
      {
        projection_id: 1,
        projection_kind: "user_assertion",
        content: userAssertion
      },
      {
        projection_id: 1,
        projection_kind: "assistant_observation",
        content: recommendation
      }
    ]);

    await expect(repo.searchByKeyword!("workspace-1", "TrailShell roll-top", 10)).resolves.toEqual([
      {
        object_id: objectId,
        normalized_rank: expect.any(Number),
        matched_projection: {
          projection_id: 1,
          projection_kind: "assistant_observation"
        }
      }
    ]);
    await expect(repo.searchByKeyword!("workspace-1", "cobalt panniers", 10)).resolves.toEqual([
      {
        object_id: objectId,
        normalized_rank: expect.any(Number),
        matched_projection: {
          projection_id: 1,
          projection_kind: "user_assertion"
        }
      }
    ]);
  });

  it("lets the stronger User child outrank a weaker Assistant child", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const objectId = "1f5c2a90-0000-4000-8000-000000000016";
    await repo.create(createEvidenceCapsule({
      object_id: objectId,
      gist: "Two child descriptions compete on keyword relevance.",
      excerpt: "Which child description should rank?",
      source_hash: "sha256:garden-source-turn-fallback-v2:stronger-user-child"
    }), [
      {
        projection_id: 1,
        projection_kind: "user_assertion",
        content: "Copperlane Copperlane Copperlane Copperlane Copperlane."
      },
      {
        projection_id: 1,
        projection_kind: "assistant_observation",
        content: "Copperlane appears in a long observation with unrelated packing, weather, transit, storage, and color details."
      }
    ]);

    const hits = await repo.searchByKeyword!("workspace-1", "Copperlane", 10);

    expect(hits).toEqual([
      {
        object_id: objectId,
        normalized_rank: expect.any(Number),
        matched_projection: {
          projection_id: 1,
          projection_kind: "user_assertion"
        }
      }
    ]);
  });

  it("uses child kind only when BM25 ranks tie exactly", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const objectId = "1f5c2a90-0000-4000-8000-000000000017";
    const identicalContent = "Cedarvault retention rule.";
    await repo.create(createEvidenceCapsule({
      object_id: objectId,
      gist: "Two identical child descriptions.",
      excerpt: "Which retention rule applies?",
      source_hash: "sha256:garden-source-turn-fallback-v2:child-rank-tie"
    }), [
      {
        projection_id: 1,
        projection_kind: "user_assertion",
        content: identicalContent
      },
      {
        projection_id: 2,
        projection_kind: "assistant_observation",
        content: identicalContent
      }
    ]);

    const hits = await repo.searchByKeyword!("workspace-1", "Cedarvault", 10);

    expect(hits).toEqual([
      {
        object_id: objectId,
        normalized_rank: 1,
        matched_projection: {
          projection_id: 2,
          projection_kind: "assistant_observation"
        }
      }
    ]);
  });

  it("uses Assistant kind when owner and child normalized ranks tie", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const objectId = "1f5c2a90-0000-4000-8000-000000000012";
    const recommendation = "Choose the TrailShell backpack for a rainy commute.";
    await repo.create(createEvidenceCapsule({
      object_id: objectId,
      gist: `User: I need a TrailShell backpack.\nAssistant: ${recommendation}`,
      excerpt: "I need a TrailShell backpack.",
      source_hash: "sha256:garden-source-turn-fallback-v2:assistant-observation"
    }), [{
      projection_id: 1,
      projection_kind: "assistant_observation",
      content: recommendation
    }]);

    const hits = await repo.searchByKeyword!("workspace-1", "TrailShell backpack", 10);

    expect(hits).toEqual([
      expect.objectContaining({
        object_id: objectId,
        normalized_rank: 1,
        matched_projection: {
          projection_id: 1,
          projection_kind: "assistant_observation"
        }
      })
    ]);
  });

  it("lets a stronger owner outrank its weaker Assistant projection", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const targetOwnerId = "1f5c2a90-0000-4000-8000-000000000018";
    const strongerProjectionOwnerId = "1f5c2a90-0000-4000-8000-000000000019";
    await repo.create(createEvidenceCapsule({
      object_id: targetOwnerId,
      gist: "Citrineanchor Citrineanchor Citrineanchor Citrineanchor.",
      excerpt: "The owner is the strongest source for the query.",
      source_hash: "sha256:garden-source-turn-fallback-v2:stronger-owner"
    }), [{
      projection_id: 1,
      projection_kind: "assistant_observation",
      content: "Citrineanchor appears once among unrelated travel, packing, weather, color, and storage details."
    }]);
    await repo.create(createEvidenceCapsule({
      object_id: strongerProjectionOwnerId,
      gist: "A different projection supplies the lane baseline.",
      excerpt: "An unrelated owner excerpt.",
      source_hash: "sha256:garden-source-turn-fallback-v2:projection-baseline"
    }), [{
      projection_id: 1,
      projection_kind: "assistant_observation",
      content: "Citrineanchor Citrineanchor Citrineanchor Citrineanchor Citrineanchor."
    }]);

    const hits = await repo.searchByKeyword!("workspace-1", "Citrineanchor", 10);
    const targetHit = hits.find((hit) => hit.object_id === targetOwnerId);

    expect(targetHit).toEqual({
      object_id: targetOwnerId,
      normalized_rank: 1
    });
  });

  it("selects the strongest concrete projection without duplicating its owner", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const objectId = "1f5c2a90-0000-4000-8000-000000000013";
    await repo.create(createEvidenceCapsule({
      object_id: objectId,
      gist: "Assistant observations about two TrailShell packs.",
      excerpt: "Which backpack should I use?",
      source_hash: "sha256:garden-source-turn-fallback-v2:assistant-observation"
    }), [
      {
        projection_id: 1,
        projection_kind: "assistant_observation",
        content: "The moss-green TrailShell pack stays dry."
      },
      {
        projection_id: 2,
        projection_kind: "assistant_observation",
        content: "The blue TrailShell pack has a larger sleeve."
      }
    ]);

    const hits = await repo.searchByKeyword!("workspace-1", "blue", 10);

    expect(hits.map((hit) => hit.matched_projection)).toEqual([
      {
        projection_id: 2,
        projection_kind: "assistant_observation"
      }
    ]);
  });

  it("applies the search limit to distinct evidence owners", async () => {
    const { repo } = await createEvidenceCapsuleRepo();
    const firstOwnerId = "1f5c2a90-0000-4000-8000-000000000014";
    const secondOwnerId = "1f5c2a90-0000-4000-8000-000000000015";
    await repo.create(createEvidenceCapsule({
      object_id: firstOwnerId,
      gist: "Two separate Assistant observations.",
      excerpt: "Which backpack should I use?",
      source_hash: "sha256:garden-source-turn-fallback-v2:first-owner"
    }), [
      {
        projection_id: 1,
        projection_kind: "assistant_observation",
        content: "The moss-green TrailShell pack stays dry."
      },
      {
        projection_id: 2,
        projection_kind: "assistant_observation",
        content: "The blue TrailShell pack has a larger sleeve."
      }
    ]);
    await repo.create(createEvidenceCapsule({
      object_id: secondOwnerId,
      gist: "One separate Assistant observation.",
      excerpt: "Which backpack should I use?",
      source_hash: "sha256:garden-source-turn-fallback-v2:second-owner"
    }), [{
      projection_id: 1,
      projection_kind: "assistant_observation",
      content: "The red TrailShell pack has reflective straps for long urban commutes in changing weather."
    }]);

    const hits = await repo.searchByKeyword!("workspace-1", "TrailShell", 2);

    expect(hits).toHaveLength(2);
    expect(new Set(hits.map((hit) => hit.object_id))).toEqual(
      new Set([firstOwnerId, secondOwnerId])
    );
  });
});
