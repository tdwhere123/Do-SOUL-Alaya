import { describe, expect, it } from "vitest";
import {
  BoundSourceInterpretationSchema,
  SOURCE_INTERPRETATION_CONTRACT
} from "@do-soul/alaya-protocol";
import {
  matchBoundInterpretation,
  sourceTextContainsPhrases
} from "../../../../recall/conditional-field/observers/source-proposal-match.js";
import type { AdoptedSourceProposal } from "../../../../recall/conditional-field/query/query-source-proposal.js";
import { SNAPSHOT_ID } from "../reference/deployment.fixture.js";

const SKETCH: AdoptedSourceProposal = {
  lookup_mode: "proposal",
  predicate_key: "access",
  arguments: [{ role: "capability", phrase: "full pc" }],
  qualifiers: [{ role: "temporal", phrase: "instantly" }]
};

describe("source proposal conjunction match", () => {
  it("requires predicate, argument, and qualifier together on one candidate", () => {
    const bound = interpretation([
      candidate("c1", { predicate: "access", capability: "full pc", temporal: "instantly" })
    ]);
    expect(matchBoundInterpretation(bound, SKETCH)?.candidate_id).toBe("c1");
  });

  it("does not combine roles from unrelated candidates in the same context", () => {
    const bound = interpretation([
      candidate("left", { predicate: "access", capability: "full pc", temporal: "later" }),
      candidate("right", { predicate: "access", capability: "phone", temporal: "instantly" })
    ]);
    expect(matchBoundInterpretation(bound, SKETCH)).toBeUndefined();
  });

  it("does not treat unrepresented polarity as a match distinguisher", () => {
    const bound = interpretation([
      candidate("negated", { predicate: "access", capability: "full pc", temporal: "instantly" })
    ]);
    expect(matchBoundInterpretation(bound, SKETCH)?.candidate_id).toBe("negated");
  });

  it("treats source-text co-occurrence as phrase presence only", () => {
    expect(sourceTextContainsPhrases("Users access a full PC instantly", ["full pc", "instantly"])).toBe(true);
    expect(sourceTextContainsPhrases("Users access a phone instantly", ["full pc", "instantly"])).toBe(false);
  });
});

function interpretation(
  candidates: ReturnType<typeof candidate>[]
) {
  return BoundSourceInterpretationSchema.parse({
    contract: SOURCE_INTERPRETATION_CONTRACT,
    artifact_key: "artifact-1",
    source_corpus_digest: SNAPSHOT_ID.slice("sha256:".length),
    assertion_binding: {
      assertion_id: 1,
      source_span: [0, 8],
      text: "assertion",
      context_id: "context-1"
    },
    outcome: "candidates",
    candidates,
    diagnostics: [],
    source_target: {
      kind: "source_evidence",
      workspace_id: "workspace-1",
      root_kind: "source_record",
      root_id: "root-1",
      source_version: "v1",
      content_digest: SNAPSHOT_ID,
      evidence_object_id: "evidence-1"
    }
  });
}

function candidate(
  id: string,
  fields: Readonly<{ predicate: string; capability: string; temporal: string }>
) {
  return {
    candidate_id: id,
    context_id: "context-1",
    predicate: phrase(fields.predicate, 0, 6),
    arguments: [{ role: "capability", phrase: phrase(fields.capability, 0, 4) }],
    qualifiers: [{ role: "temporal", phrase: phrase(fields.temporal, 0, 4) }],
    scope_status: "unsupported" as const
  };
}

function phrase(text: string, start: number, end: number) {
  return { text, source_span: [start, end] as const, lookup_key: text };
}
