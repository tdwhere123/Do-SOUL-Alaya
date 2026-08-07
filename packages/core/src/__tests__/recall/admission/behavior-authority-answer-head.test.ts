import { describe, expect, it } from "vitest";
import { retainBehaviorAuthorityAnswerHead } from
  "../../../recall/delivery/admission/answer-head/behavior-authority-answer-head.js";
import { selectBoundedDirectEvidenceHead } from
  "../../../recall/delivery/admission/direct-evidence-answer-head.js";
import { compileRecallQueryProbes } from
  "../../../recall/query/recall-query-probes.js";
import { createCandidate } from
  "../fine-assessment-selection-fixtures.js";

describe("behavior authority answer head", () => {
  it("keeps an eligible candidate already in the protected head in place", () => {
    const selection = simpleSelection(["a", "b", "c", "d", "e", "f"]);
    const retained = retainBehaviorAuthorityAnswerHead({
      selection,
      rankLimit: 5,
      selectDelivered: (candidates) => candidates,
      keyOf: (candidate) => candidate,
      isBehaviorEligible: (candidate) => candidate === "b"
    });

    expect(retained.candidates).toEqual(selection.candidates);
    expect(retained.protections).toEqual([{ candidateKey: "b", rankLimit: 5 }]);
  });

  it("leaves zero, ambiguous, and short-head opportunities unchanged", () => {
    const selection = simpleSelection(["a", "b", "c", "d", "e", "f", "g"]);
    const unchanged = (eligible: (candidate: string) => boolean, candidates = selection) =>
      retainBehaviorAuthorityAnswerHead({
        selection: candidates,
        rankLimit: 5,
        selectDelivered: (ordered) => ordered,
        keyOf: (candidate) => candidate,
        isBehaviorEligible: eligible
      });

    expect(unchanged(() => false)).toEqual(selection);
    expect(unchanged((candidate) => candidate === "f" || candidate === "g"))
      .toEqual(selection);
    const short = simpleSelection(["a", "b"]);
    expect(unchanged(() => true, short)).toEqual(short);
  });

  it("protects one verified opportunity at the answer boundary", () => {
    const candidates = Array.from({ length: 6 }, (_, index) =>
      createCandidate(`candidate-${index + 1}`));
    const opportunity = candidates[5]!;

    const selection = selectBoundedDirectEvidenceHead(
      candidates,
      compileRecallQueryProbes("Where did I buy my bookshelf?"),
      new Map(),
      new Map(),
      10,
      new Set(),
      (ordered) => ordered,
      (candidate) => candidate === opportunity
    );

    expect(selection.protections).toContainEqual({
      candidateKey: opportunity.fusion.candidate_key,
      rankLimit: 5
    });
    expect(selection.candidates[4]).toBe(opportunity);
  });

  it("does not choose between ambiguous verified opportunities", () => {
    const candidates = Array.from({ length: 7 }, (_, index) =>
      createCandidate(`candidate-${index + 1}`));

    const selection = selectBoundedDirectEvidenceHead(
      candidates,
      compileRecallQueryProbes("Where did I buy my bookshelf?"),
      new Map(),
      new Map(),
      10,
      new Set(),
      (ordered) => ordered,
      (candidate) => candidate === candidates[5] || candidate === candidates[6]
    );

    expect(selection.protections).toEqual([]);
  });

  it("does not protect evidence against a weaker admission victim than the public head victim", () => {
    const memories = [
      ...Array.from({ length: 4 }, (_, index) => createCandidate(`head-${index + 1}`)),
      createCandidate("gold", { content: "I currently use Acme shampoo brand." }),
      ...Array.from({ length: 4 }, (_, index) => createCandidate(`tail-${index + 1}`)),
      createCandidate("admission-victim", { content: "Unrelated deployment note." })
    ];
    const evidenceBase = createCandidate(
      "evidence",
      { content: "What do creatures currently use?" },
      "evidence_capsule"
    );
    const evidence = {
      ...evidenceBase,
      fusion: {
        ...evidenceBase.fusion,
        candidate_key: "workspace_local:evidence_capsule:evidence",
        per_stream_rank: {
          ...evidenceBase.fusion.per_stream_rank,
          evidence_fts: 5
        }
      }
    };
    const candidates = [...memories, evidence];
    const publicRelevance = new Map(candidates.map((candidate, index) => [
      candidate.fusion.candidate_key,
      candidate.entry.object_id === "gold" ? 0.6 : Math.max(0.1, 1 - index * 0.1)
    ]));
    publicRelevance.set(evidence.fusion.candidate_key, 0.1);

    const selection = selectBoundedDirectEvidenceHead(
      candidates,
      compileRecallQueryProbes("What brand of shampoo do I currently use?"),
      new Map(),
      publicRelevance,
      10,
      new Set(),
      (ordered) => ordered.slice(0, 10),
      () => false
    );

    expect(selection.protections).not.toContainEqual({
      candidateKey: evidence.fusion.candidate_key,
      rankLimit: 5
    });
    expect(selection.candidates).toEqual(candidates);
  });

  it("uses source identity before replay-local IDs for tied direct evidence promotion", () => {
    const first = promotedEvidenceSource({ alphaId: "z-alpha", zebraId: "a-zebra" });
    const replay = promotedEvidenceSource({ alphaId: "a-alpha", zebraId: "z-zebra" });

    expect(first).toBe(replay);
    expect(first).toBe("sha256:source-alpha");
  });

  it("uses semantic identity before replay-local IDs within one evidence source", () => {
    const first = promotedEvidenceContent({ alphaId: "z-alpha", zebraId: "a-zebra" });
    const replay = promotedEvidenceContent({ alphaId: "a-alpha", zebraId: "z-zebra" });

    expect(first).toBe(replay);
    expect(first).toBe("Use cobalt storage for alpha cache entries.");
  });
});

function promotedEvidenceSource(params: Readonly<{
  readonly alphaId: string;
  readonly zebraId: string;
}>): string | undefined {
  const baseline = createCandidate("baseline", { content: "Unrelated note." });
  const candidates = [
    baseline,
    directEvidenceCandidate(params.alphaId, "sha256:source-alpha"),
    directEvidenceCandidate(params.zebraId, "sha256:source-zebra")
  ];
  const selection = selectBoundedDirectEvidenceHead(
    candidates,
    compileRecallQueryProbes("cobalt storage"),
    new Map(),
    new Map(),
    1,
    new Set(),
    (ordered) => ordered.slice(0, 1),
    () => false
  );
  return selection.candidates[0]?.evidenceSourceIdentity;
}

function promotedEvidenceContent(params: Readonly<{
  readonly alphaId: string;
  readonly zebraId: string;
}>): string | undefined {
  const baseline = createCandidate("baseline", { content: "Unrelated note." });
  const candidates = [
    baseline,
    directEvidenceCandidate(
      params.alphaId,
      "sha256:source-shared",
      "Use cobalt storage for alpha cache entries."
    ),
    directEvidenceCandidate(
      params.zebraId,
      "sha256:source-shared",
      "Use cobalt storage for zebra cache entries."
    )
  ];
  const selection = selectBoundedDirectEvidenceHead(
    candidates,
    compileRecallQueryProbes("cobalt storage"),
    new Map(),
    new Map(),
    1,
    new Set(),
    (ordered) => ordered.slice(0, 1),
    () => false
  );
  return selection.candidates[0]?.entry.content;
}

function directEvidenceCandidate(
  objectId: string,
  evidenceSourceIdentity: string,
  content = "I use cobalt storage for replay artifacts."
) {
  const candidate = createCandidate(
    objectId,
    { content },
    "evidence_capsule"
  );
  return {
    ...candidate,
    evidenceSourceIdentity,
    fusion: {
      ...candidate.fusion,
      candidate_key: `workspace_local:evidence_capsule:${objectId}`,
      per_stream_rank: {
        ...candidate.fusion.per_stream_rank,
        evidence_fts: 1
      }
    }
  };
}

function simpleSelection(candidates: readonly string[]) {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    protections: Object.freeze([]),
    rejectedCandidateKeys: Object.freeze([])
  });
}
