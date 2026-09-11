import { describe, expect, it } from "vitest";
import {
  CONDITIONAL_FIELD_SCHEMA_VERSION,
  type Continuation,
  type QueryInterpretation
} from "@do-soul/alaya-protocol";
import { createConditionalField } from "../../../../recall/conditional-field/engine/field-engine.js";
import { interpretationIdentity } from "../../../../recall/conditional-field/query/compile-query-identity.js";
import {
  rememberField,
  restoreField,
  sealIssuedContinuation
} from "../../../../recall/runtime/index-continuation.js";
import {
  INTERPRETATION_CLOCK,
  QUERY_ID,
  SNAPSHOT_ID,
  defaultBudget,
  defaultView,
  identityAssociationCap
} from "../reference/deployment.fixture.js";

describe("issued continuation tamper matrix", () => {
  it("restores an exact issued token and fails closed on each authoritative mutation", () => {
    const state = createConditionalField({
      interpretation: interpretation(),
      budget: defaultBudget()
    });
    const issued = issuedToken({ "product-a": "rev-a" });
    rememberField(state, issued);
    expect(restoreField(issued, INTERPRETATION_CLOCK, interpretationId())).toBe(state);

    const { enumeration_policy: _policy, ...withoutPolicy } = issued;
    expect(restoreField(withoutPolicy, INTERPRETATION_CLOCK, interpretationId())).toBe(state);

    expect(restoreField(withoutCapability(issued), INTERPRETATION_CLOCK, interpretationId()))
      .toBeUndefined();

    for (const tampered of authoritativeMutations(issued)) {
      expect(restoreField(tampered, INTERPRETATION_CLOCK, interpretationId())).toBeUndefined();
    }
  });
});

function interpretation(): QueryInterpretation {
  return {
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    status: "resolved",
    program: { schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION, kind: "epsilon" },
    view: defaultView(),
    holes: [],
    hypotheses: [],
    interpretation_clock: INTERPRETATION_CLOCK
  };
}

function interpretationId(): string {
  return interpretationIdentity({ interpretation_clock: INTERPRETATION_CLOCK });
}

function issuedToken(emitted?: Readonly<Record<string, string>>): Continuation {
  return sealIssuedContinuation({
    schema_version: CONDITIONAL_FIELD_SCHEMA_VERSION,
    continuation_id: "page-1",
    query_id: QUERY_ID,
    snapshot_id: SNAPSHOT_ID,
    result_version: "v1",
    expires_at: "2099-01-01T00:00:00.000Z",
    cursor: "o1|abc",
    interpretation_id: interpretationId(),
    interpretation_clock: INTERPRETATION_CLOCK,
    enumeration_policy: "canonical",
    result_kind_view: "mixed",
    authorized_scopes: null,
    cap_contracts: [],
    claim_demands: [],
    protocol_version: 1,
    supported_result_kinds: ["memory_entry"],
    ...(emitted === undefined ? {} : { emitted_revisions: emitted })
  });
}

function withoutCapability(continuation: Continuation): Continuation {
  const { capability: _capability, ...rest } = continuation;
  return rest;
}

function authoritativeMutations(issued: Continuation): Continuation[] {
  const extra = { ...(issued.emitted_revisions ?? {}), "product-extra": "rev-extra" };
  const removed = { ...(issued.emitted_revisions ?? {}) };
  delete removed["product-a"];
  const changed = { ...(issued.emitted_revisions ?? {}), "product-a": "rev-forged" };
  return [
    { ...issued, continuation_id: "forged-id" },
    { ...issued, query_id: "other-query" },
    { ...issued, snapshot_id: `sha256:${"d".repeat(64)}` },
    { ...issued, result_version: "v2" },
    { ...issued, expires_at: "2098-01-01T00:00:00.000Z" },
    { ...issued, cursor: "o99|tampered" },
    { ...issued, interpretation_id: "other-interpretation" },
    { ...issued, interpretation_clock: "2020-01-01T00:00:00.000Z" },
    { ...issued, enumeration_policy: "associative" },
    { ...issued, result_kind_view: "memory_only" },
    { ...issued, authorized_scopes: [] },
    { ...issued, emitted_revisions: extra },
    { ...issued, emitted_revisions: removed },
    { ...issued, emitted_revisions: changed },
    { ...issued, cap_contracts: [identityAssociationCap()] },
    { ...issued, claim_demands: [{
      variable: "h",
      proposition_kind: "common_cause",
      argument_variables: ["r", "h"],
      required_claim: "any"
    }] },
    { ...issued, protocol_version: 2 },
    { ...issued, supported_result_kinds: ["source_evidence"] },
    { ...issued, capability: "b".repeat(64) }
  ];
}
