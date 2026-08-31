import { createHash } from "node:crypto";
import {
  buildVerifiedUserAssertionReceiptPreimage,
  formatVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import { describe, expect, it } from "vitest";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import { createDeps, createSignal } from "./materialization-router-fixture.js";

const ASSERTION = "I use the cobalt release channel for production deployments.";

describe("verified assertion receipt admission", () => {
  it("rejects a shape-valid wrong digest before verified Evidence is written", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const result = await router.materializeSignal(createSignal({
      source: "garden_compile",
      raw_payload: {
        matched_text: ASSERTION,
        distilled_fact: ASSERTION,
        source_assertion: ASSERTION,
        full_turn_content: `User: ${ASSERTION}`,
        verified_user_assertion_source_hash:
          `sha256:garden-verified-user-assertion-v1:${"0".repeat(64)}`,
        source_locator: {
          contract_version: 2,
          kind: "assertion_catalog",
          assertion_id: 1
        },
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: ASSERTION,
          proposed_matched_text: ASSERTION,
          reasons: []
        }
      }
    }));

    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      target_kind: "deferred",
      route_target: "deferred",
      defer_reason: "source_grounding_rejected"
    });
  });

  it("rejects a recomputed receipt for Assistant-owned text", async () => {
    const corpus = `User: I moved to Berlin.\nAssistant: ${ASSERTION}`;
    const result = await materializeRawPayload(verifiedRawPayload({
      corpus,
      assertion: ASSERTION,
      sourceLocator: assertionLocator(1)
    }));

    expect(result.evidenceCreate).not.toHaveBeenCalled();
    expect(result.materialization).toMatchObject({
      target_kind: "deferred",
      defer_reason: "source_grounding_rejected"
    });
  });

  it("rejects a recomputed receipt with a malformed locator", async () => {
    const corpus = `User: ${ASSERTION}`;
    const result = await materializeRawPayload(verifiedRawPayload({
      corpus,
      assertion: ASSERTION,
      sourceLocator: {
        contract_version: 2,
        kind: "assertion_catalog",
        assertion_id: "1"
      }
    }));

    expect(result.evidenceCreate).not.toHaveBeenCalled();
    expect(result.materialization).toMatchObject({
      target_kind: "deferred",
      defer_reason: "source_grounding_rejected"
    });
  });
});

async function materializeRawPayload(rawPayload: Record<string, unknown>) {
  const deps = createDeps();
  const router = new MaterializationRouter(deps);
  const materialization = await router.materializeSignal(createSignal({
    source: "garden_compile",
    raw_payload: rawPayload
  }));
  return { materialization, evidenceCreate: deps.evidenceService.create };
}

function verifiedRawPayload(input: Readonly<{
  readonly corpus: string;
  readonly assertion: string;
  readonly sourceLocator: unknown;
}>): Record<string, unknown> {
  return {
    matched_text: input.assertion,
    distilled_fact: input.assertion,
    source_assertion: input.assertion,
    full_turn_content: input.corpus,
    verified_user_assertion_source_hash: verifiedReceipt(input.assertion, input.corpus),
    source_locator: input.sourceLocator,
    source_grounding: {
      version: 1,
      status: "grounded",
      content_basis: "source_assertion",
      source_assertion: input.assertion,
      proposed_matched_text: input.assertion,
      reasons: []
    }
  };
}

function verifiedReceipt(assertion: string, corpus: string): string {
  const digest = createHash("sha256").update(buildVerifiedUserAssertionReceiptPreimage({
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source_assertion: assertion,
    source_corpus: corpus
  }), "utf8").digest("hex");
  return formatVerifiedUserAssertionSourceHash(digest);
}

function assertionLocator(assertionId: number) {
  return {
    contract_version: 2,
    kind: "assertion_catalog",
    assertion_id: assertionId
  };
}
