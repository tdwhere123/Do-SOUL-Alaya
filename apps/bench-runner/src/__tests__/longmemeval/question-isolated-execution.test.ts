import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  runIsolatedQuestionSequence,
  type IsolatedQuestionSequenceInput
} from "../../longmemeval/lifecycle/question-isolated-execution.js";
import {
  emptySeedFuelInventory,
  mergeSeedFuelInventories,
  type SeedFuelInventory
} from "../../longmemeval/seed-fuel-inventory.js";

interface TestDaemon {
  readonly db: DatabaseSync;
  readonly root: string;
}

interface DbObservation {
  readonly question: string;
  readonly objects: number;
  readonly events: number;
  readonly paths: number;
}

describe("question-isolated execution", () => {
  it("returns the same per-question results in reverse order", async () => {
    const forward = await runFixture(["alpha", "beta"]);
    const reverse = await runFixture(["beta", "alpha"]);

    expect(sortedResults(forward.results)).toEqual(sortedResults(reverse.results));
  });

  it("starts the second question with no first-question DB state", async () => {
    const observations: DbObservation[] = [];
    await runFixture(["first", "second"], observations);

    expect(observations).toEqual([
      { question: "first", objects: 0, events: 0, paths: 0 },
      { question: "second", objects: 0, events: 0, paths: 0 }
    ]);
  });

  it("retains bounded question evidence when shutdown fails", async () => {
    let questionRoot: string | undefined;
    const input = fixtureInput(["only"], [], {
      onStart: (root) => { questionRoot = root; },
      shutdownError: new Error("shutdown failed")
    });

    await expect(runIsolatedQuestionSequence(input)).rejects.toThrow("shutdown failed");
    expect(questionRoot).toBeDefined();
    await expect(readFile(join(questionRoot ?? "missing", "FAILED_RUN_EVIDENCE.txt"), "utf8"))
      .resolves.toContain("Retained failed benchmark run evidence");
    await rm(questionRoot ?? "missing", { recursive: true, force: true });
  });

  it("retains the question ID when a handled question failure continues the sequence", async () => {
    let questionRoot: string | undefined;
    const input = fixtureInput(["failed-question"], [], {
      onStart: (root) => { questionRoot = root; },
      successful: false
    });

    await expect(runIsolatedQuestionSequence(input)).resolves.toMatchObject({
      results: [{ questionId: "failed-question" }]
    });
    await expect(readFile(join(questionRoot ?? "missing", "FAILED_QUESTION.txt"), "utf8"))
      .resolves.toBe("failed-question\n");
    await rm(questionRoot ?? "missing", { recursive: true, force: true });
  });

  it("never removes the supplied parent root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "alaya-question-parent-test-"));
    const sentinel = join(parent, "keep.txt");
    await writeFile(sentinel, "keep", "utf8");
    try {
      await runIsolatedQuestionSequence({
        ...fixtureInput(["only"], []),
        rootParent: parent
      });
      await expect(access(sentinel)).resolves.toBeUndefined();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("rejects a root prefix that escapes its parent", async () => {
    const input = fixtureInput(["only"], []);

    await expect(runIsolatedQuestionSequence({
      ...input,
      rootPrefix: "../outside-"
    })).rejects.toThrow("question root prefix must be a non-empty basename");
  });

  it("aggregates each inventory as soon as its question completes", async () => {
    const result = await runFixture(["one", "two"]);

    expect(result.aggregate).toEqual({
      objects_total: 2,
      evidence_refs_total: 2,
      facet_anchors_total: 1,
      path_candidates_total: 2,
      support_bearing_candidates: 2
    });
  });

  it("preserves a single question result", async () => {
    const result = await runFixture(["solo"]);

    expect(result.results).toEqual([{ questionId: "solo", score: 4 }]);
  });
});

async function runFixture(
  questions: readonly string[],
  observations: DbObservation[] = []
) {
  return runIsolatedQuestionSequence(fixtureInput(questions, observations));
}

function fixtureInput(
  questions: readonly string[],
  observations: DbObservation[],
  options: {
    readonly onStart?: (root: string) => void;
    readonly shutdownError?: Error;
    readonly successful?: boolean;
  } = {}
): IsolatedQuestionSequenceInput<string, TestDaemon, { questionId: string; score: number }, SeedFuelInventory, SeedFuelInventory> {
  return {
    questions,
    rootPrefix: "alaya-question-isolation-test-",
    initialAggregate: emptySeedFuelInventory(),
    mergeAggregate: (aggregate, inventory) =>
      mergeSeedFuelInventories([aggregate, inventory]),
    start: async (root) => startTestDaemon(root.path, options.onStart),
    run: async (daemon, question) => runTestQuestion(daemon, question, observations),
    collect: async (daemon) => collectTestInventory(daemon),
    shutdown: async (daemon) => {
      daemon.db.close();
      if (options.shutdownError !== undefined) throw options.shutdownError;
    },
    isSuccessful: () => options.successful ?? true,
    failureLabel: (question) => question
  };
}

function startTestDaemon(
  root: string,
  onStart: ((root: string) => void) | undefined
): TestDaemon {
  onStart?.(root);
  const db = new DatabaseSync(join(root, "question.db"));
  db.exec("CREATE TABLE objects(id TEXT); CREATE TABLE events(id TEXT); CREATE TABLE paths(id TEXT)");
  return { db, root };
}

function runTestQuestion(
  daemon: TestDaemon,
  question: string,
  observations: DbObservation[]
): { readonly questionId: string; readonly score: number } {
  observations.push({
    question,
    objects: tableCount(daemon.db, "objects"),
    events: tableCount(daemon.db, "events"),
    paths: tableCount(daemon.db, "paths")
  });
  for (const table of ["objects", "events", "paths"]) {
    daemon.db.prepare(`INSERT INTO ${table}(id) VALUES (?)`).run(question);
  }
  return { questionId: question, score: question.length };
}

function collectTestInventory(daemon: TestDaemon): SeedFuelInventory {
  return {
    objects_total: tableCount(daemon.db, "objects"),
    evidence_refs_total: tableCount(daemon.db, "events"),
    facet_anchors_total: 1,
    path_candidates_total: tableCount(daemon.db, "paths"),
    support_bearing_candidates: tableCount(daemon.db, "objects")
  };
}

function tableCount(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function sortedResults(
  results: readonly { readonly questionId: string; readonly score: number }[]
) {
  return [...results].sort((left, right) => left.questionId.localeCompare(right.questionId));
}
