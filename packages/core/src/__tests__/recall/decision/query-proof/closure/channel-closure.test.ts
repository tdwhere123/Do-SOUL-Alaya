import { describe, expect, it } from "vitest";

import {
  bindClosureReceiptScope,
  closeFiniteFieldChannel,
  closeRefinementStopCertificate,
  createFiniteClosureUniverseWitness,
  type ChannelClosureScope,
  type ChannelRemainingEffect
} from "../../../../../recall/decision/query-proof/closure/index.js";
import { createRecallFiniteFieldSeal } from
  "../../../../../recall/field/finite-field-seal.js";

const QUERY = `sha256:${"1".repeat(64)}` as const;
const REQUEST = `sha256:${"2".repeat(64)}` as const;
const SNAPSHOT = `sha256:${"3".repeat(64)}` as const;
const PRINCIPAL = `sha256:${"4".repeat(64)}` as const;
const UNIVERSE = `sha256:${"5".repeat(64)}` as const;

describe("finite-field channel closure", () => {
  it("closes exact finite scope and proves absence only inside its eligible universe", () => {
    const seal = finiteSeal("complete", 0);
    const scope = closureScope();
    const universe = createFiniteClosureUniverseWitness({
      scope,
      source_receipt_digest: seal.channels[0]!.channel_digest,
      candidate_key_domain: "memory_object_id",
      eligible_candidate_keys: ["candidate-a", "candidate-absent"]
    });
    const binding = bindClosureReceiptScope({
      scope,
      source_receipt_digest: seal.channels[0]!.channel_digest,
      universe_digest: universe.universe_digest
    });

    const result = closeFiniteFieldChannel({ seal, scope, universe, binding });

    expect(result.status).toBe("exact_closed");
    expect(result.remaining_effects).toEqual([]);
    expect(result.completeness_refs).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("candidate-absent");
  });

  it.each([
    ["query_digest", `sha256:${"6".repeat(64)}`],
    ["snapshot_digest", `sha256:${"7".repeat(64)}`],
    ["principal_digest", `sha256:${"8".repeat(64)}`],
    ["domain_id", "different-domain"],
    ["universe_digest", `sha256:${"9".repeat(64)}`]
  ] as const)("fails closed when %s differs", (field, value) => {
    const seal = finiteSeal("complete", 0);
    const original = closureScope();
    const universe = createFiniteClosureUniverseWitness({
      scope: original,
      source_receipt_digest: seal.channels[0]!.channel_digest,
      candidate_key_domain: "memory_object_id",
      eligible_candidate_keys: ["candidate-a"]
    });
    const binding = bindClosureReceiptScope({
      scope: original,
      source_receipt_digest: seal.channels[0]!.channel_digest,
      universe_digest: universe.universe_digest
    });
    const scope = field === "universe_digest"
      ? original
      : { ...original, [field]: value };
    const changedUniverse = field === "universe_digest"
      ? { ...universe, universe_digest: value }
      : universe;

    expect(closeFiniteFieldChannel({
      seal,
      scope: scope as ChannelClosureScope,
      universe: changedUniverse,
      binding
    }).status).toBe("uncertified");
  });

  it("keeps truncated and unavailable evidence open", () => {
    const scope = closureScope();
    const truncated = finiteSeal("truncated", 0.4);
    const effect = boundedEffect();
    const binding = bindClosureReceiptScope({
      scope,
      source_receipt_digest: truncated.channels[0]!.channel_digest,
      universe_digest: UNIVERSE
    });

    expect(closeFiniteFieldChannel({
      seal: truncated,
      scope,
      binding,
      bounded_effects: [effect]
    }).status).toBe("bounded_open");
    expect(closeFiniteFieldChannel({
      seal: truncated,
      scope,
      binding
    }).status).toBe("uncertified");
    expect(closeFiniteFieldChannel({
      seal: finiteSeal("unavailable", null),
      scope,
      binding
    }).status).toBe("uncertified");
  });

  it("treats ineligible as exact non-applicability", () => {
    const seal = finiteSeal("ineligible", null);
    const scope = closureScope();
    const binding = bindClosureReceiptScope({
      scope,
      source_receipt_digest: seal.channels[0]!.channel_digest,
      universe_digest: UNIVERSE
    });

    expect(closeFiniteFieldChannel({ seal, scope, binding }).status)
      .toBe("not_applicable");
  });

  it("does not let a legacy selector stop certificate impersonate query closure", () => {
    const result = closeRefinementStopCertificate({
      certificate: {
        status: "certified",
        reason: "exchange_dominated"
      } as never,
      scope: closureScope()
    });

    expect(result.status).toBe("uncertified");
    expect(result.reason).toBe("source_receipt_invalid");
  });

  it("does not expose hidden-universe identities or counts", () => {
    const first = closeWithHiddenState(["hidden-a"]);
    const second = closeWithHiddenState(["hidden-a", "hidden-b", "hidden-c"]);
    expect(first).toEqual(second);
  });
});

function closeWithHiddenState(_hidden: readonly string[]) {
  const seal = finiteSeal("complete", 0);
  const scope = closureScope();
  const universe = createFiniteClosureUniverseWitness({
    scope,
    source_receipt_digest: seal.channels[0]!.channel_digest,
    candidate_key_domain: "memory_object_id",
    eligible_candidate_keys: ["candidate-a"]
  });
  return closeFiniteFieldChannel({
    seal,
    scope,
    universe,
    binding: bindClosureReceiptScope({
      scope,
      source_receipt_digest: seal.channels[0]!.channel_digest,
      universe_digest: universe.universe_digest
    })
  });
}

function closureScope(): ChannelClosureScope {
  return Object.freeze({
    query_digest: QUERY,
    request_digest: REQUEST,
    snapshot_digest: SNAPSHOT,
    principal_digest: PRINCIPAL,
    workspace_id: "workspace-1",
    observer_id: "finite-field-test-observer",
    channel_id: "test-channel",
    domain_id: "memory-object-membership",
    universe_digest: UNIVERSE,
    sensitivities: Object.freeze([{
      sensitivity_id: "answer:x",
      effect: "answer_binding" as const,
      target: "x"
    }])
  });
}

function boundedEffect(): ChannelRemainingEffect {
  return Object.freeze({
    effect_id: "answer:x:remaining",
    sensitivity_id: "answer:x",
    effect: "answer_binding",
    possible_bindings: Object.freeze(["binding-a", "binding-b"])
  });
}

function finiteSeal(
  status: "complete" | "truncated" | "unavailable" | "ineligible",
  unseenUpperBound: number | null
) {
  const observed = status === "complete" || status === "truncated";
  return createRecallFiniteFieldSeal({
    upstream_snapshot_digest: SNAPSHOT,
    channel_catalog: ["test-channel"],
    channels: [{
      channel_id: "test-channel",
      status,
      depth: observed ? 1 : 0,
      observations: observed ? [{
        observation_id: "test:a",
        candidate_key: "candidate-a",
        rank: 1
      }] : [],
      unseen_upper_bound: unseenUpperBound
    }]
  });
}
