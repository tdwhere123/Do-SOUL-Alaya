import type { SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import {
  BENCH_SEED_ROTATION,
  rotatingSeedObjectKind,
  type BenchDaemonHandle,
  type SeedObjectKind
} from "../harness/daemon.js";
import type {
  FixtureQuestion,
  FixtureSeed,
  ScenarioLabel,
  SeedSidecar
} from "./types.js";

export const SCENARIO_LABELS = [
  "uniform-fact",
  "rotated-kind",
  "stress-policy-max10-conflict-true",
  "chat-policy-max10-conflict-false",
  "cold-report-context-usage-none",
  "warm-report-context-usage-mixed"
] as const satisfies readonly ScenarioLabel[];

export const FIXTURE_SEEDS: readonly FixtureSeed[] = Object.freeze([
  {
    id: "alpha-owner",
    content: "Controlled replay alpha owner: Atlas indexing remains owned by packages/core for M0 fixture comparison."
  },
  {
    id: "bravo-budget",
    content: "Controlled replay bravo budget: Kappa cap pressure should preserve max entries evidence."
  },
  {
    id: "charlie-preference",
    content: "Controlled replay charlie preference: operators prefer temp history roots for fixture archives."
  },
  {
    id: "delta-decision",
    content: "Controlled replay delta decision: replay archives must avoid latest baseline mutation."
  },
  {
    id: "echo-constraint",
    content: "Controlled replay echo constraint: controlled replay must not create kpi json output."
  },
  {
    id: "foxtrot-outcome",
    content: "Controlled replay foxtrot outcome: warm usage reporting uses the recall delivery id."
  },
  {
    id: "golf-lexical",
    content: "Controlled replay golf lexical: high lexical terms should still show demotion diagnostics when ranking changes."
  },
  {
    id: "hotel-conflict",
    content: "Controlled replay hotel conflict: claim-like memories expose conflict penalty under stress policy."
  },
  {
    id: "india-chat",
    content: "Controlled replay india chat: chat policy disables conflict awareness for comparison."
  },
  {
    id: "juliet-warm",
    content: "Controlled replay juliet warm: mixed report context usage should create trust evidence before a second recall."
  },
  {
    id: "kilo-rotation",
    content: "Controlled replay kilo rotation: fact preference decision constraint outcome kinds rotate over identical content."
  },
  {
    id: "lima-suspect",
    content: "Controlled replay lima suspect: top contribution suspects compare object kind, budget, conflict, and warm deltas."
  },
  {
    id: "mike-evidence-only",
    content: "Controlled replay mike evidence-only: raw source excerpt contains the talisman phrase nebula-quartz bridge.",
    distilledFact: "Controlled replay mike evidence-only: source evidence carries the retrieval-only phrase."
  },
  {
    id: "november-path-source",
    content: "Controlled replay november path source: repeated warm usage links this seed to a separate paired answer."
  },
  {
    id: "oscar-path-target",
    content: "Controlled replay oscar paired answer: orange-ridge answer is only taught through co-usage."
  }
]);

export const FIXTURE_QUESTIONS: readonly FixtureQuestion[] = Object.freeze([
  {
    id: "q-owner",
    question: "Which controlled replay alpha owner memory names Atlas indexing and packages/core?",
    expectedSeedIds: ["alpha-owner"]
  },
  {
    id: "q-archive",
    question: "Which controlled replay archive memory says not to create kpi json or latest baseline output?",
    expectedSeedIds: ["delta-decision", "echo-constraint"]
  },
  {
    id: "q-warm",
    question: "Which controlled replay warm memory mentions using a delivery id for report context usage?",
    expectedSeedIds: ["foxtrot-outcome", "juliet-warm"]
  },
  {
    id: "q-evidence-only",
    question: "Which controlled replay source evidence contains the nebula-quartz phrase?",
    expectedSeedIds: ["mike-evidence-only"]
  },
  {
    id: "q-path-target",
    question: "Which controlled replay memory should november path source lead to after repeated use?",
    expectedSeedIds: ["oscar-path-target"]
  },
  {
    id: "q-path-pair-a",
    question: "Which controlled replay november path source and orange-ridge answer belong together?",
    expectedSeedIds: ["november-path-source", "oscar-path-target"]
  },
  {
    id: "q-path-pair-b",
    question: "Which controlled replay orange-ridge answer is paired with the november path source?",
    expectedSeedIds: ["november-path-source", "oscar-path-target"]
  },
  {
    id: "q-path-pair-c",
    question: "Which controlled replay november path source repeats with the orange-ridge paired answer?",
    expectedSeedIds: ["november-path-source", "oscar-path-target"]
  }
]);

export function scenarioConfigFor(label: ScenarioLabel): {
  readonly maxEntries: number;
  readonly conflictAwareness: boolean;
  readonly reportContextUsage: "none" | "mixed";
  readonly kindForSeed: (index: number) => SeedObjectKind;
} {
  const rotated = (index: number) => rotatingSeedObjectKind(index);
  switch (label) {
    case "uniform-fact":
      return {
        maxEntries: 10,
        conflictAwareness: true,
        reportContextUsage: "none",
        kindForSeed: () => "fact"
      };
    case "chat-policy-max10-conflict-false":
      return {
        maxEntries: 10,
        conflictAwareness: false,
        reportContextUsage: "none",
        kindForSeed: rotated
      };
    case "warm-report-context-usage-mixed":
      return {
        maxEntries: 10,
        conflictAwareness: true,
        reportContextUsage: "mixed",
        kindForSeed: rotated
      };
    case "rotated-kind":
    case "stress-policy-max10-conflict-true":
    case "cold-report-context-usage-none":
      return {
        maxEntries: 10,
        conflictAwareness: true,
        reportContextUsage: "none",
        kindForSeed: rotated
      };
  }
}

export async function seedFixture(
  daemon: BenchDaemonHandle,
  kindForSeed: (index: number) => SeedObjectKind
): Promise<readonly SeedSidecar[]> {
  const seeds: SeedSidecar[] = [];
  for (let index = 0; index < FIXTURE_SEEDS.length; index++) {
    const fixtureSeed = FIXTURE_SEEDS[index];
    if (fixtureSeed === undefined) continue;
    const objectKind = kindForSeed(index);
    const seed = await daemon.proposeMemory(
      fixtureSeed.content,
      `controlled-replay-${fixtureSeed.id}`,
      {
        objectKind,
        ...(fixtureSeed.distilledFact === undefined
          ? {}
          : { distilledFact: fixtureSeed.distilledFact })
      }
    );
    seeds.push({
      fixtureId: fixtureSeed.id,
      objectKind,
      memoryId: seed.memoryId,
      signalId: seed.signalId,
      proposalId: seed.proposalId
    });
  }
  return seeds;
}

export async function reportMixedUsage(
  daemon: BenchDaemonHandle,
  recall: SoulMemorySearchResponse,
  question: FixtureQuestion,
  sidecar: ReadonlyMap<string, SeedSidecar>,
  turnIndex: number
): Promise<void> {
  const expected = new Set(question.expectedSeedIds);
  const usedObjectIds = recall.results
    .filter((result) => {
      const seed = sidecar.get(result.object_id);
      return seed !== undefined && expected.has(seed.fixtureId);
    })
    .map((result) => result.object_id);
  const fallbackUsed = usedObjectIds.length === 0 && recall.results[0] !== undefined
    ? [recall.results[0].object_id]
    : usedObjectIds;
  await daemon.reportContextUsage({
    deliveryId: recall.delivery_id,
    usageState: fallbackUsed.length > 0 ? "used" : "skipped",
    ...(fallbackUsed.length === 0 ? {} : { usedObjectIds: fallbackUsed }),
    deliveredObjects: recall.results.slice(0, 10).map((result) => ({
      objectId: result.object_id,
      objectKind: result.object_kind,
      usageStatus: fallbackUsed.includes(result.object_id) ? "used" : "skipped"
    })),
    turnIndex,
    turnDigest: {
      lastMessages: [
        {
          role: "user",
          contentExcerpt: question.question
        }
      ]
    },
    reason: "controlled replay warm mixed usage fixture"
  });
}

export { BENCH_SEED_ROTATION };
