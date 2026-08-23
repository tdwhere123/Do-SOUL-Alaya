import { describe, expect, it } from "vitest";
import {
  selectGammaWalk
} from "../../../recall/delivery/select-gamma/select-gamma.js";

const REQUEST = Object.freeze({
  workspace_id: "workspace-1",
  generation_id: `sha256:${"a".repeat(64)}`,
  condition_digest: `sha256:${"b".repeat(64)}`,
  eligible_candidate_keys: ["duplicate-a", "duplicate-b", "novel"],
  token_budget: 10
});
const BINDING = Object.freeze({
  workspace_id: REQUEST.workspace_id,
  generation_id: REQUEST.generation_id,
  condition_digest: REQUEST.condition_digest,
  feature_weights: Object.freeze({}),
  max_selected: 3,
  per_dimension_limits: null
});

describe("Select_Gamma admission walk", () => {
  it("rejects a duplicate inside the walk and refills with a novel candidate", () => {
    const result = selectGammaWalk(REQUEST, {
      ...BINDING,
      candidates: [
        candidate("duplicate-a", 3, { object_key: "memory:shared" }),
        candidate("duplicate-b", 2, { object_key: "memory:shared" }),
        candidate("novel", 1, { object_key: "memory:novel" })
      ],
      max_selected: 2
    });

    expect(result.selected_candidate_keys).toEqual(["duplicate-a", "novel"]);
    expect(result.decisions.find(({ candidate_key }) =>
      candidate_key === "duplicate-b")?.receipt).toMatchObject({
      kind: "duplicate",
      identity_channel: "object",
      retained_candidate_key: "duplicate-a"
    });
  });

  it("rejects a repeated source identity and refills with a novel candidate", () => {
    const result = selectGammaWalk(REQUEST, {
      ...BINDING,
      candidates: [
        candidate("duplicate-a", 3, { source: "shared" }),
        candidate("duplicate-b", 2, { source: "shared" }),
        candidate("novel", 1, { source: "novel" })
      ],
      max_selected: 2
    });

    expect(result.selected_candidate_keys).toEqual(["duplicate-a", "novel"]);
    expect(result.decisions.find(({ candidate_key }) =>
      candidate_key === "duplicate-b")?.receipt).toMatchObject({
      kind: "duplicate",
      identity_channel: "source",
      retained_candidate_key: "duplicate-a"
    });
  });

  it("treats omitted source_hard_dedupe as on", () => {
    const candidates = [
      candidate("duplicate-a", 3, { source: "shared" }),
      candidate("duplicate-b", 2, { source: "shared" }),
      candidate("novel", 1, { source: "novel" })
    ];
    const omitted = selectGammaWalk(REQUEST, {
      ...BINDING,
      candidates,
      max_selected: 2
    });
    const explicit = selectGammaWalk(REQUEST, {
      ...BINDING,
      candidates,
      max_selected: 2,
      source_hard_dedupe: true
    });

    expect(omitted.selected_candidate_keys).toEqual(explicit.selected_candidate_keys);
    expect(omitted.decisions.map(({ candidate_key, receipt }) => ({
      candidate_key,
      receipt
    }))).toEqual(explicit.decisions.map(({ candidate_key, receipt }) => ({
      candidate_key,
      receipt
    })));
  });

  it("admits distinct objects from one source when source hard-dedupe is off", () => {
    const result = selectGammaWalk(REQUEST, {
      ...BINDING,
      source_hard_dedupe: false,
      candidates: [
        candidate("duplicate-a", 3, {
          object_key: "memory:a",
          source: "shared"
        }),
        candidate("duplicate-b", 2, {
          object_key: "memory:b",
          source: "shared"
        }),
        candidate("novel", 1, {
          object_key: "memory:novel",
          source: "novel"
        })
      ],
      max_selected: 2
    });

    expect(result.selected_candidate_keys).toEqual(["duplicate-a", "duplicate-b"]);
    expect(result.decisions.filter((decision) =>
      decision.receipt.kind === "duplicate")).toEqual([]);
  });

  it("still rejects a duplicate object when source hard-dedupe is off", () => {
    const result = selectGammaWalk(REQUEST, {
      ...BINDING,
      source_hard_dedupe: false,
      candidates: [
        candidate("duplicate-a", 3, {
          object_key: "memory:shared",
          source: "shared"
        }),
        candidate("duplicate-b", 2, {
          object_key: "memory:shared",
          source: "shared"
        }),
        candidate("novel", 1, {
          object_key: "memory:novel",
          source: "other"
        })
      ],
      max_selected: 2
    });

    expect(result.selected_candidate_keys).toEqual(["duplicate-a", "novel"]);
    expect(result.decisions.find(({ candidate_key }) =>
      candidate_key === "duplicate-b")?.receipt).toMatchObject({
      kind: "duplicate",
      identity_channel: "object",
      retained_candidate_key: "duplicate-a"
    });
  });

  it("admits a second distinct object that shares lineage", () => {
    const result = selectGammaWalk(REQUEST, {
      ...BINDING,
      candidates: [
        candidate("duplicate-a", 3, {
          object_key: "memory:a",
          lineage: "session:shared"
        }),
        candidate("duplicate-b", 2, {
          object_key: "memory:b",
          lineage: "session:shared"
        }),
        candidate("novel", 1, {
          object_key: "memory:novel",
          lineage: "session:novel"
        })
      ],
      max_selected: 2
    });

    expect(result.selected_candidate_keys).toEqual(["duplicate-a", "duplicate-b"]);
    expect(result.decisions.filter((decision) =>
      decision.receipt.kind === "duplicate")).toEqual([]);
  });

  it("rejects a saturated dimension inside the walk and refills another dimension", () => {
    const result = selectGammaWalk(REQUEST, {
      ...BINDING,
      candidates: [
        candidate("duplicate-a", 3, { dimension: "procedure" }),
        candidate("duplicate-b", 2, { dimension: "procedure" }),
        candidate("novel", 1, { dimension: "preference" })
      ],
      max_selected: 2,
      per_dimension_limits: { procedure: 1 }
    });

    expect(result.selected_candidate_keys).toEqual(["duplicate-a", "novel"]);
    expect(result.decisions.find(({ candidate_key }) =>
      candidate_key === "duplicate-b")?.receipt).toMatchObject({
      kind: "dimension_limit",
      dimension: "procedure",
      accepted_before: 1,
      limit: 1
    });
  });

  it("validates max_selected and unique eligible keys", () => {
    expect(() => selectGammaWalk(REQUEST, {
      ...BINDING,
      candidates: [candidate("duplicate-a", 1)],
      max_selected: -1
    })).toThrow(/max_selected/u);
    expect(() => selectGammaWalk({
      ...REQUEST,
      eligible_candidate_keys: ["duplicate-a", "duplicate-a"]
    }, {
      ...BINDING,
      candidates: [candidate("duplicate-a", 1)]
    })).toThrow(/eligible candidate keys must be unique/u);
  });

  it("fails closed on request, binding, or candidate workspace drift", () => {
    const bound = {
      ...BINDING,
      candidates: [candidate("duplicate-a", 1)]
    };
    expect(() => selectGammaWalk({ ...REQUEST, workspace_id: "workspace-2" }, bound))
      .toThrow(/identity/u);
    expect(() => selectGammaWalk(REQUEST, {
      ...bound,
      candidates: [{ ...candidate("duplicate-a", 1), workspace_id: "workspace-2" }]
    })).toThrow(/candidate workspace/u);
  });

  it("keeps an empty selection bound to explicit request identity", () => {
    expect(selectGammaWalk({ ...REQUEST, eligible_candidate_keys: [] }, {
      ...BINDING,
      candidates: []
    }).selected_candidate_keys).toEqual([]);
  });
});

function candidate(
  candidateKey: string,
  quality: number,
  constraints: Readonly<{
    readonly object_key?: string;
    readonly dimension?: string;
    readonly source?: string;
    readonly lineage?: string;
  }> = {}
) {
  return Object.freeze({
    workspace_id: REQUEST.workspace_id,
    candidate_key: candidateKey,
    eligibility: { risk: "clear" as const, authority: "clear" as const },
    token_cost: 1,
    quality,
    cover: {},
    object_key: constraints.object_key ?? candidateKey,
    dimension: constraints.dimension ?? "procedure",
    source: constraints.source === undefined
      ? { status: "unavailable" as const }
      : { status: "available" as const, key: constraints.source },
    lineage: constraints.lineage === undefined
      ? { status: "unavailable" as const }
      : { status: "available" as const, key: constraints.lineage },
    authority_tie_break: "unavailable" as const,
    quality_channels: {
      temporal: { status: "unavailable" as const }
    }
  });
}
