import { afterEach, describe, expect, it } from "vitest";
import {
  createMemoryEntry,
  createRepo,
  trackedDatabases
} from "./memory-entry-repo-fixture.js";

const databases = trackedDatabases;

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteMemoryEntryRepo keyword search", () => {
  it("searches memory content through the FTS supplement index", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Implement recall via FTS keyword supplement."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Archive unused memories after decay."
      })
    );

    const matches = await repo.searchByKeyword("workspace-1", "recall", 5);

    expect(matches).toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      })
    ]);
  });

  it("normalizes bm25-ordered rows into a meaningful ordinal ladder", async () => {
    const { database, repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-1111-4111-8111-111111111111",
        content: "Stable review evidence needs exact witness lines."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "aaaaaaaa-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Stable review evidence matters, but exact witnesses matter more."
      })
    );

    const rawMatches = database.connection
      .prepare(
        `
          SELECT object_id, bm25(memory_content_fts) AS raw_rank
          FROM memory_content_fts
          WHERE workspace_id = ? AND memory_content_fts MATCH ?
          ORDER BY raw_rank ASC, object_id ASC
        `
      )
      .all("workspace-1", '"stable"') as Array<{ readonly object_id: string; readonly raw_rank: number }>;
    const normalizedMatches = await repo.searchByKeyword("workspace-1", "stable", 5);

    expect(normalizedMatches.map((match) => match.object_id)).toEqual(
      rawMatches.map((match) => match.object_id)
    );
    expect(normalizedMatches).toHaveLength(2);
    expect(normalizedMatches[0]!.normalized_rank).toBe(1);
    expect(normalizedMatches[1]!.normalized_rank).toBe(0.5);
  });

  it("restores short exact-token matches that trigram MATCH cannot satisfy", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "33333333-1111-4111-8111-111111111111",
        content: "Go build before review."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "44444444-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Rust build before review."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-3333-4333-8333-333333333333",
        run_id: "run-2",
        content: "Governance reviews need evidence."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "go", 5)).resolves.toEqual([
      {
        object_id: "33333333-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("can filter short-token keyword fallback results to a hot candidate set before the limit bites", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Go archive the oldest report."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Go prune the stale cache row."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-9999-4999-8999-999999999999",
        content: "Go keep the hot supplement candidate alive."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "go", 2)).resolves.toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111"
      }),
      expect.objectContaining({
        object_id: "22222222-2222-4222-8222-222222222222"
      })
    ]);
    await expect(
      repo.searchByKeywordWithinObjectIds!(
        "workspace-1",
        "go",
        2,
        ["99999999-9999-4999-8999-999999999999"]
      )
    ).resolves.toEqual([
      {
        object_id: "99999999-9999-4999-8999-999999999999",
        normalized_rank: 1
      }
    ]);
  });

  it("finds short-token keyword matches beyond the first exact-scan batch", async () => {
    const { repo } = await createRepo();
    for (let index = 0; index < 205; index += 1) {
      await repo.create(
        createMemoryEntry({
          object_id: `${String(index + 1).padStart(8, "0")}-1111-4111-8111-111111111111`,
          content: index === 204 ? "Go keep the late exact match." : `Governance filler row ${index}.`
        })
      );
    }

    await expect(repo.searchByKeyword("workspace-1", "go", 5)).resolves.toEqual([
      {
        object_id: "00000205-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("excludes tombstoned hot rows from hot-tier recall and short-token keyword fallback", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Go keep the live recall candidate.",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Go drop the tombstoned recall candidate.",
        retention_state: "tombstoned"
      })
    );

    await expect(repo.findByWorkspaceId("workspace-1")).resolves.toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111"
      })
    ]);
    await expect(repo.searchByKeyword("workspace-1", "go", 5)).resolves.toEqual([
      {
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
    await expect(
      repo.searchByKeywordWithinObjectIds!(
        "workspace-1",
        "go",
        5,
        [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        ]
      )
    ).resolves.toEqual([
      {
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("matches mid-token substrings after the trigram upgrade", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-1111-4111-8111-111111111111",
        content: "Canonicalization keeps memory lookup stable across review waves."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "66666666-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Stable reviews still need exact evidence."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "nicaliza", 5)).resolves.toEqual([
      {
        object_id: "55555555-1111-4111-8111-111111111111",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("matches CJK substrings through the trigram-backed FTS path", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "77777777-3333-4333-8333-333333333333",
        content: "请记住中文路径需要逐字保留，避免命名漂移。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "88888888-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "英文路径在这个用例里不重要。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "路径需要", 5)).resolves.toEqual([
      {
        object_id: "77777777-3333-4333-8333-333333333333",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("restores short CJK span matches below the trigram boundary", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-3333-4333-8333-333333333333",
        content: "请记住路径规则必须逐字校验。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "aaaaaaaa-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "这条规则与界面布局无关。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "路径", 5)).resolves.toEqual([
      {
        object_id: "99999999-3333-4333-8333-333333333333",
        normalized_rank: 1
      }
    ]);
  });

  it("sanitizes FTS special operators before searching", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "33333333-3333-4333-8333-333333333333",
        content: "Use the contentsecret fallback token for recall ranking."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "44444444-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "A plain secret token should not match the sanitized literal."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", 'content:secret*', 5)).resolves.toEqual([
      {
        object_id: "33333333-3333-4333-8333-333333333333",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("strips NUL bytes from keyword query tokens before FTS matching", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "bbbbbbbb-1111-4111-8111-111111111111",
        content: "The alphabeta token should survive NUL sanitization."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "cccccccc-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "The alpha token alone must not match the sanitized query."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "alpha\0beta", 5)).resolves.toEqual([
      {
        object_id: "bbbbbbbb-1111-4111-8111-111111111111",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("anchor search admits only rows containing a required anchor", async () => {
    const { repo } = await createRepo();
    const withAnchor = "eeeeeeee-1111-4111-8111-111111111111";
    const optionalOnly = "ffffffff-2222-4222-8222-222222222222";
    await repo.create(
      createMemoryEntry({ object_id: withAnchor, content: "Melanie hosted the dinner downtown." })
    );
    await repo.create(
      createMemoryEntry({
        object_id: optionalOnly,
        run_id: "run-2",
        content: "The dinner downtown was catered for everyone."
      })
    );

    await expect(
      repo.searchByAnchorWithinObjectIds!(
        "workspace-1",
        ["melanie"],
        ["dinner"],
        5,
        [withAnchor, optionalOnly]
      )
    ).resolves.toEqual([expect.objectContaining({ object_id: withAnchor })]);

    await expect(
      repo.searchByAnchorWithinObjectIds!("workspace-1", [], ["dinner"], 5, [withAnchor, optionalOnly])
    ).resolves.toEqual([]);
  });

  it("caps keyword query tokens before building an FTS MATCH expression", async () => {
    const { repo } = await createRepo();
    const boundedTokens = Array.from({ length: 32 }, (_, index) => `absent${index + 1}`);
    await repo.create(
      createMemoryEntry({
        object_id: "dddddddd-3333-4333-8333-333333333333",
        content: "The overlimitmatch token appears only past the bounded query token set."
      })
    );

    await expect(
      repo.searchByKeyword("workspace-1", `${boundedTokens.join(" ")} overlimitmatch`, 5)
    ).resolves.toEqual([]);
  });

});
