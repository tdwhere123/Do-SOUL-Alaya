import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaimLifecycleState,
  FieldGenerationEventType,
  GovernanceResolutionEventType,
  PROOF_EFFECT_OPERATOR_ID,
  PROOF_EFFECT_OPERATOR_VERSION,
  ScopeClass,
  canonicalGovernanceSubject,
  hashEffectGovernanceFrontier,
  type ClaimForm,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "@do-soul/alaya-storage";
import { ClaimService, type ClaimServiceDependencies } from "../../governance/claims/claim-service.js";
import { EventPublisher } from "../../runtime/event-publisher.js";
import {
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createResolutionServiceRealStorage
} from "../shared/real-sqlite.test-support.js";
import { buildEffectDecisionReceipt } from "../../governance/effects/proof-effect-policy.js";
import { buildEffectAuditEventInput } from "../../governance/proposals/resolution-service-effects.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";

const FIXED_NOW = "2026-05-17T00:00:00.000Z";

// invariant: B5 — proves the atomic-rollback contract on real SQLite,
// not just the wiring. The resolution-confirm path composes its
// governance-resolution audit event into the SAME appendManyWithMutation
// transaction as the claim_status mutation. A throw inside the mutate
// callback must roll BOTH back: neither the audit-event EventLog row nor
// the claim_status change may survive. Mocking transitionLifecycle (the
// dispatch tests above) cannot prove this — only a genuine SQLite
// transaction can.
// see also: packages/core/src/governance/claim-service.ts applyLifecycleTransition
describe("ResolutionService confirm atomicity (real SQLite)", () => {
  const databases = new Set<StorageDatabase>();

  afterEach(() => {
    for (const database of databases) {
      database.close();
    }
    databases.clear();
  });

  const CLAIM_ID = "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a";
  const WS = REAL_SQLITE_TEST_WORKSPACE_ID;

  function buildDraftClaim(): ClaimForm {
    return {
      object_id: CLAIM_ID,
      object_kind: "claim_form",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: FIXED_NOW,
      updated_at: FIXED_NOW,
      created_by: "user_action",
      governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
      claim_kind: "constraint",
      scope_class: ScopeClass.PROJECT,
      enforcement_level: "strict",
      origin_tier: "user_explicit",
      precedence_basis: "authority",
      proposition_digest: "Use pnpm for workspace commands.",
      evidence_refs: [],
      source_object_refs: [],
      workspace_id: WS,
      claim_status: ClaimLifecycleState.DRAFT
    } as ClaimForm;
  }

  it("rolls back BOTH the audit-event row and the claim_status mutation when the mutate throws", async () => {
    const { database, eventLogRepo, claimFormRepo } = await createResolutionServiceRealStorage((database) => {
      databases.add(database);
    });
    claimFormRepo.create(buildDraftClaim());
    database.connection.exec(`
      CREATE TABLE test_effect_decisions (
        request_digest TEXT PRIMARY KEY,
        decision TEXT NOT NULL
      )
    `);

    const witnesses = [
      { receipt_id: "auth-1", kind: "actor_authority", authority_event_id: "delivery-event-1",
        source_record_id: null,
        source_content_digest: null },
      { receipt_id: "source-1", kind: "source_grounding", authority_event_id: null,
        source_record_id: "record-1",
        source_content_digest: "digest-1" }
    ];
    const effectDecision = buildEffectDecisionReceipt({
      schema_version: 2,
      workspace_id: WS,
      actor_id: "codex",
      run_id: "run-1",
      delivery_id: "delivery-1",
      action: "activate",
      target: CLAIM_ID,
      scope: WS,
      effective_as_of: FIXED_NOW,
      supporting_receipt_ids: ["auth-1", "source-1"],
      supporting_proof_witnesses: witnesses,
      governance_frontier: hashEffectGovernanceFrontier(witnesses, fieldContractSha256),
      policy_operator_id: PROOF_EFFECT_OPERATOR_ID,
      policy_operator_version: PROOF_EFFECT_OPERATOR_VERSION
    }, "allow", FIXED_NOW, fieldContractSha256);

    const eventPublisher = new EventPublisher({
      eventLogRepo,
      runHotStateService: { apply: vi.fn(async () => undefined) },
      runtimeNotifier: { notify: vi.fn(), notifyEntry: vi.fn() }
    });

    // The injected failure: updateStatusSync throws from INSIDE the
    // appendManyWithMutation mutate callback. The append of the
    // lifecycle event and the composed audit event already ran in the
    // open transaction; the throw must roll the whole transaction back.
    const failingClaimFormRepo: ClaimServiceDependencies["claimFormRepo"] = new Proxy(claimFormRepo, {
      get(target, prop, receiver) {
        if (prop === "updateStatusSync") {
          return () => {
            throw new Error("synthetic claim_status mutation failure");
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });

    const claimService = new ClaimService({
      claimFormRepo: failingClaimFormRepo,
      eventLogRepo,
      runtimeNotifier: { notifyEntry: vi.fn() },
      eventPublisher,
      effectDecisionStore: {
        insert: (receipt) => {
          database.connection.prepare(`
            INSERT INTO test_effect_decisions (request_digest, decision) VALUES (?, ?)
          `).run(receipt.request_digest, receipt.decision);
          return receipt;
        }
      },
      now: () => FIXED_NOW
    });

    const auditEventsSink: EventLogEntry[] = [];
    await expect(
      claimService.transitionLifecycle(
        CLAIM_ID,
        ClaimLifecycleState.ACTIVE,
        "soul_resolve_confirm",
        "user",
        {
          skipSlotElection: true,
          additionalEventInputs: [
            {
              event_type: GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED,
              entity_type: "claim_form",
              entity_id: CLAIM_ID,
              workspace_id: WS,
              run_id: null,
              caused_by: "user",
              payload_json: {
                target_object_id: CLAIM_ID,
                target_object_kind: "claim_form",
                workspace_id: WS,
                run_id: null,
                resolution: "confirm",
                policy: null,
                delivery_id: "delivery-1",
                agent_target: "codex",
                activated_claim_id: CLAIM_ID,
                obligation_id: null,
                correction: null,
                reason: null,
                resolved_at: FIXED_NOW
              }
            },
            buildEffectAuditEventInput(effectDecision)
          ],
          additionalEventsSink: auditEventsSink,
          effectDecisionReceipt: effectDecision
        }
      )
    ).rejects.toThrow("synthetic claim_status mutation failure");

    // The audit event row must NOT have persisted.
    const auditRows = database.connection
      .prepare(
        `SELECT COUNT(*) AS n FROM event_log WHERE event_type = ?`
      )
      .get(GovernanceResolutionEventType.SOUL_RESOLUTION_CONFIRM_APPLIED) as { n: number };
    expect(auditRows.n).toBe(0);

    // The lifecycle-change event row must NOT have persisted either.
    const lifecycleRows = database.connection
      .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE event_type = ?`)
      .get("soul.claim.lifecycle_changed") as { n: number };
    expect(lifecycleRows.n).toBe(0);

    const effectAuditRows = database.connection
      .prepare(`SELECT COUNT(*) AS n FROM event_log WHERE event_type = ?`)
      .get(FieldGenerationEventType.SOUL_FIELD_EFFECT_DECIDED) as { n: number };
    expect(effectAuditRows.n).toBe(0);

    const effectDecisionRows = database.connection
      .prepare(`SELECT COUNT(*) AS n FROM test_effect_decisions`)
      .get() as { n: number };
    expect(effectDecisionRows.n).toBe(0);

    // The claim_status mutation must NOT have persisted — still DRAFT.
    // This is the durable atomicity proof: the event_log rows and the
    // claim_status row both vanish on rollback. (additionalEventsSink is
    // an in-memory array populated before the throw inside the same
    // callback; it is intentionally not asserted — the caller never reads
    // it on a thrown transition, and only durable state is transactional.)
    const reloaded = await claimFormRepo.findById(CLAIM_ID);
    expect(reloaded?.claim_status).toBe(ClaimLifecycleState.DRAFT);
  });
});
