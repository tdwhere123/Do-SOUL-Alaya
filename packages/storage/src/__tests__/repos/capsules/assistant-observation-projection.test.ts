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
  it("prefers an equal-rank child descriptor and keeps kind-local numeric identities", async () => {
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

  it("uses the concrete child as the owner representative when both match", async () => {
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
        matched_projection: {
          projection_id: 1,
          projection_kind: "assistant_observation"
        }
      })
    ]);
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
