import { afterEach, describe, expect, it, vi } from "vitest";
import { splitFtsLanes } from "@do-soul/alaya-protocol";
import { prepareEvidenceCapsuleStatements } from
  "../../../repos/capsules/evidence-capsule-statements.js";
import { buildEvidenceKeywordFieldResult } from
  "../../../repos/capsules/evidence-search/evidence-keyword-merge.js";
import {
  collectEvidenceKeywordLaneRowsSeparate,
  collectEvidenceKeywordLaneRowsUnion,
  searchEvidenceByKeywordField
} from "../../../repos/capsules/evidence-search/evidence-keyword-search.js";
import type {
  EvidenceKeywordLaneBundle,
  ProjectionRankRow
} from "../../../repos/capsules/evidence-search/evidence-keyword-types.js";
import type {
  EvidenceCapsuleKeywordHit,
  EvidenceKeywordFieldResult
} from "../../../repos/capsules/evidence-recall-types.js";
import { tokenizeFtsQuery } from "../../../repos/shared/fts-lane-routing.js";
import {
  createEvidenceCapsule,
  createEvidenceCapsuleRepo,
  evidenceCapsuleDatabases
} from "./evidence-capsule-repo-fixture.js";

afterEach(() => {
  for (const database of evidenceCapsuleDatabases) {
    database.close();
  }
  evidenceCapsuleDatabases.clear();
});

describe("evidence keyword four-query vs UNION ALL", () => {
  it("merges a recorded four-lane fixture by object id, rank, and lane", () => {
    const lanes = recordedFourLaneFixture();
    const field = buildEvidenceKeywordFieldResult(lanes, 5, [], true, true);
    expect(fieldIdentity(field)).toEqual(recordedFourLaneExpected());
    expect(fieldIdentity(buildEvidenceKeywordFieldResult(lanes, 5, [], true, true)))
      .toEqual(fieldIdentity(field));
  });

  it("returns the same rows and merged ranks as the four-query path", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    await seedEquivalenceWorkspace(repo);
    const statements = prepareEvidenceCapsuleStatements(database);
    const queryText = "部署流水线 deployment";
    const { porterTokens, trigramTokens } = splitQuery(queryText);
    expect(porterTokens.length).toBeGreaterThan(0);
    expect(trigramTokens.length).toBeGreaterThan(0);

    const separate = collectEvidenceKeywordLaneRowsSeparate(
      statements, "workspace-1", porterTokens, trigramTokens, 10
    );
    const union = collectEvidenceKeywordLaneRowsUnion(
      statements, "workspace-1", porterTokens, trigramTokens, 10
    );

    expect(summarizeLanes(union)).toEqual(summarizeLanes(separate));
    expect(fieldIdentity(buildEvidenceKeywordFieldResult(union, 10, [], true, true)))
      .toEqual(fieldIdentity(buildEvidenceKeywordFieldResult(separate, 10, [], true, true)));
    expect(fieldIdentity(searchEvidenceByKeywordField(
      statements, "workspace-1", queryText, 10
    ))).toEqual(fieldIdentity(buildEvidenceKeywordFieldResult(
      separate, 10, [], true, true
    )));
  });

  it("keeps porter-only and trigram-only ranks on the separate-lane path", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    await seedEquivalenceWorkspace(repo);
    const statements = prepareEvidenceCapsuleStatements(database);

    for (const queryText of ["TrailShell pack", "部署流水线"]) {
      const { porterTokens, trigramTokens } = splitQuery(queryText);
      const separate = collectEvidenceKeywordLaneRowsSeparate(
        statements, "workspace-1", porterTokens, trigramTokens, 10
      );
      expect(fieldIdentity(searchEvidenceByKeywordField(
        statements, "workspace-1", queryText, 10
      ))).toEqual(fieldIdentity(buildEvidenceKeywordFieldResult(
        separate, 10, [], porterTokens.length > 0, trigramTokens.length > 0
      )));
    }
  });

  it("queries maxDepth once when materializing refinement levels", async () => {
    const { database, repo } = await createEvidenceCapsuleRepo();
    await seedEquivalenceWorkspace(repo);
    const statements = prepareEvidenceCapsuleStatements(database);
    const ownerUnion = vi.spyOn(statements.searchOwnerByKeywordUnionStatement, "all");
    const projectionUnion = vi.spyOn(statements.searchProjectionByKeywordUnionStatement, "all");
    const porterOwner = vi.spyOn(statements.searchByKeywordStatement, "all");

    const field = searchEvidenceByKeywordField(
      statements, "workspace-1", "部署流水线 deployment", 1, [3]
    );

    expect(ownerUnion).toHaveBeenCalledTimes(1);
    expect(projectionUnion).toHaveBeenCalledTimes(1);
    expect(porterOwner).not.toHaveBeenCalled();
    expect(ownerUnion.mock.calls[0]?.[2]).toBe(3);
    expect(field.matches).toHaveLength(1);
    expect(field.refinement_levels?.[0]?.matches.length).toBeGreaterThan(1);
  });
});

function splitQuery(queryText: string): ReturnType<typeof splitFtsLanes> {
  return splitFtsLanes(tokenizeFtsQuery(queryText));
}

async function seedEquivalenceWorkspace(
  repo: Awaited<ReturnType<typeof createEvidenceCapsuleRepo>>["repo"]
): Promise<void> {
  await repo.create(createEvidenceCapsule({
    object_id: "a0000000-0000-4000-8000-000000000001",
    gist: "The deployment pipeline rotates staging credentials nightly.",
    excerpt: "deployment pipeline credentials",
    source_hash: "sha256:porter-owner"
  }));
  await repo.create(createEvidenceCapsule({
    object_id: "b0000000-0000-4000-8000-000000000001",
    gist: "用户每天晚上轮换部署流水线的临时凭证。",
    excerpt: "轮换部署流水线凭证",
    source_hash: "sha256:trigram-owner"
  }));
  await repo.create(createEvidenceCapsule({
    object_id: "c0000000-0000-4000-8000-000000000001",
    gist: "The 部署流水线 pipeline rotates 凭证 every night.",
    excerpt: "pipeline rotates 凭证",
    source_hash: "sha256:mixed-owner"
  }));
  await repo.create(createEvidenceCapsule({
    object_id: "d0000000-0000-4000-8000-000000000001",
    gist: "receipt owner about backpacks",
    excerpt: "A broad trusted User turn.",
    source_hash: "sha256:projection-owner"
  }), [
    {
      projection_id: 1,
      projection_kind: "user_assertion",
      content: "I bought my bookshelf from IKEA."
    },
    {
      projection_id: 1,
      projection_kind: "assistant_observation",
      content: "Choose the moss-green TrailShell pack for rain."
    },
    {
      projection_id: 2,
      projection_kind: "user_assertion",
      content: "部署流水线 should rotate credentials."
    }
  ]);
  await repo.create(createEvidenceCapsule({
    object_id: "e0000000-0000-4000-8000-000000000001",
    gist: "owner without matching excerpt",
    excerpt: "unrelated lunch note",
    source_hash: "sha256:projection-cjk"
  }), [
    {
      projection_id: 1,
      projection_kind: "user_assertion",
      content: "部署流水线全程自动化。"
    }
  ]);
}

function recordedFourLaneFixture(): EvidenceKeywordLaneBundle {
  return Object.freeze({
    porter: Object.freeze({
      owners: Object.freeze([{ object_id: "p-owner", raw_rank: -1 }]),
      projections: Object.freeze([projectionRow({
        object_id: "p-proj",
        raw_rank: -2,
        projection_id: 1,
        projection_kind: "assistant_observation",
        projection_content: "obs",
        owner_content: "owner",
        owner_gist: "gist",
        source_hash: "sha256:a"
      })])
    }),
    trigram: Object.freeze({
      owners: Object.freeze([{ object_id: "t-owner", raw_rank: -1 }]),
      projections: Object.freeze([projectionRow({
        object_id: "t-proj",
        raw_rank: -2,
        projection_id: 3,
        projection_kind: "user_assertion",
        projection_content: "assert",
        owner_content: "owner-t",
        owner_gist: "gist-t",
        source_hash: "sha256:b"
      })])
    })
  });
}

function recordedFourLaneExpected(): ReturnType<typeof fieldIdentity> {
  return {
    matches: [
      hitIdentity({
        object_id: "p-owner",
        normalized_rank: 1,
        matched_fts_lanes: ["porter"]
      }),
      hitIdentity({
        object_id: "p-proj",
        normalized_rank: 1,
        matched_fts_lanes: ["porter"],
        matched_projection: { projection_id: 1, projection_kind: "assistant_observation" }
      }),
      hitIdentity({
        object_id: "t-owner",
        normalized_rank: 1,
        matched_fts_lanes: ["trigram"]
      }),
      hitIdentity({
        object_id: "t-proj",
        normalized_rank: 1,
        matched_fts_lanes: ["trigram"],
        matched_projection: { projection_id: 3, projection_kind: "user_assertion" }
      })
    ],
    lanes: [
      { lane: "exact", status: "ineligible", depth: 0, unseen_upper_bound: null, observations: [] },
      {
        lane: "porter",
        status: "complete",
        depth: 2,
        unseen_upper_bound: 0,
        observations: [
          {
            ...hitIdentity({
              object_id: "p-owner",
              normalized_rank: 1,
              matched_fts_lanes: ["porter"]
            }),
            rank: 1,
            source_id: "owner:p-owner"
          },
          {
            ...hitIdentity({
              object_id: "p-proj",
              normalized_rank: 1,
              matched_fts_lanes: ["porter"],
              matched_projection: { projection_id: 1, projection_kind: "assistant_observation" }
            }),
            rank: 2,
            source_id: "projection:p-proj:assistant_observation:1"
          }
        ]
      },
      {
        lane: "trigram",
        status: "complete",
        depth: 2,
        unseen_upper_bound: 0,
        observations: [
          {
            ...hitIdentity({
              object_id: "t-owner",
              normalized_rank: 1,
              matched_fts_lanes: ["trigram"]
            }),
            rank: 1,
            source_id: "owner:t-owner"
          },
          {
            ...hitIdentity({
              object_id: "t-proj",
              normalized_rank: 1,
              matched_fts_lanes: ["trigram"],
              matched_projection: { projection_id: 3, projection_kind: "user_assertion" }
            }),
            rank: 2,
            source_id: "projection:t-proj:user_assertion:3"
          }
        ]
      }
    ]
  };
}

function projectionRow(row: ProjectionRankRow): ProjectionRankRow {
  return Object.freeze(row);
}

function summarizeLanes(lanes: EvidenceKeywordLaneBundle) {
  return {
    porter: summarizeLane(lanes.porter),
    trigram: summarizeLane(lanes.trigram)
  };
}

function summarizeLane(rows: EvidenceKeywordLaneBundle["porter"]) {
  return {
    owners: rows.owners.map((row) => ({
      object_id: row.object_id,
      raw_rank: row.raw_rank
    })),
    projections: rows.projections.map((row) => ({
      object_id: row.object_id,
      raw_rank: row.raw_rank,
      projection_id: row.projection_id,
      projection_kind: row.projection_kind,
      projection_content: row.projection_content,
      owner_content: row.owner_content,
      owner_gist: row.owner_gist,
      source_hash: row.source_hash
    }))
  };
}

function fieldIdentity(field: Readonly<EvidenceKeywordFieldResult>) {
  return {
    matches: field.matches.map(hitIdentity),
    lanes: field.lanes.map((lane) => ({
      lane: lane.lane,
      status: lane.status,
      depth: lane.depth,
      unseen_upper_bound: lane.unseen_upper_bound,
      observations: lane.observations.map((observation) => ({
        ...hitIdentity(observation),
        rank: observation.rank,
        source_id: observation.source_id
      }))
    })),
    ...(field.refinement_levels === undefined
      ? {}
      : {
          refinement_levels: field.refinement_levels.map((level) => ({
            requested_depth: level.requested_depth,
            matches: level.matches.map(hitIdentity),
            lanes: level.lanes.map((lane) => ({
              lane: lane.lane,
              status: lane.status,
              depth: lane.depth,
              unseen_upper_bound: lane.unseen_upper_bound,
              observations: lane.observations.map((observation) => ({
                ...hitIdentity(observation),
                rank: observation.rank,
                source_id: observation.source_id
              }))
            }))
          }))
        })
  };
}

function hitIdentity(hit: Readonly<EvidenceCapsuleKeywordHit>) {
  return {
    object_id: hit.object_id,
    normalized_rank: hit.normalized_rank,
    matched_fts_lanes: [...hit.matched_fts_lanes],
    matched_projection: hit.matched_projection ?? null
  };
}
