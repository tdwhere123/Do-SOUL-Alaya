import type { AdmittedSemanticArtifact, SemanticArtifactCodec, SemanticArtifactWork,
  SemanticExtractionProfile, SemanticSourceSnapshot } from "@do-soul/alaya-protocol";
import { planOfficialApiSemanticWorkset, assertOfficialApiSemanticWorkUnit,
  type OfficialApiSemanticWorkUnit } from "./semantic-workset.js";
import { auditOfficialApiSignalFormation } from "./formation-audit.js";
import { canonicalizeSemanticExtractionProfile, computeSemanticArtifactKey } from
  "./semantic-artifact-identity.js";
import { buildOfficialApiSourceCorpus } from "../../triage/grounding/source-locator.js";

/** Shares the source work-unit and formation owners; artifacts contain proposals, never admitted truth. */
export class OfficialApiSemanticArtifactCodec implements SemanticArtifactCodec {
  public plan(source: SemanticSourceSnapshot, profile: SemanticExtractionProfile): readonly SemanticArtifactWork[] {
    const canonical = canonicalizeSemanticExtractionProfile(profile);
    const units = planOfficialApiSemanticWorkset(source.content, [
      { role: source.trustedRole, content: source.content }
    ]).units;
    return units.map((unit) => ({
      key: computeSemanticArtifactKey(unit.semanticKey, canonical),
      semanticKey: unit.semanticKey,
      requestJson: JSON.stringify({ semanticKey: unit.semanticKey, text: unit.text,
        semanticContext: unit.semanticIdentity.semanticContext,
        trustedRole: unit.semanticIdentity.trustedRole, profile: canonical }),
      admissionJson: JSON.stringify(unit),
      bindingJson: JSON.stringify(unit.binding)
    }));
  }

  public admit(source: SemanticSourceSnapshot, work: SemanticArtifactWork, rawJson: string): AdmittedSemanticArtifact {
    const unit = JSON.parse(work.admissionJson) as OfficialApiSemanticWorkUnit;
    const { profile } = JSON.parse(work.requestJson) as { profile: SemanticExtractionProfile };
    assertOfficialApiSemanticWorkUnit(unit);
    const canonical = canonicalizeSemanticExtractionProfile(profile);
    if (computeSemanticArtifactKey(unit.semanticKey, canonical) !== work.key ||
      unit.semanticKey !== work.semanticKey ||
      unit.sourceCorpus !== buildOfficialApiSourceCorpus(source.content, [
        { role: source.trustedRole, content: source.content }
      ])) {
      throw new Error("semantic artifact source mismatch");
    }
    const raw = JSON.parse(rawJson) as { signals?: unknown[] };
    if (!Array.isArray(raw.signals) || raw.signals.length === 0 || raw.signals.length > 64) {
      throw new Error("semantic artifact requires a complete nonempty response");
    }
    const audit = auditOfficialApiSignalFormation({
      raw_json: rawJson, turn_content: unit.text,
      allow_legacy_single_user_source: source.trustedRole === 'user',
      workspace_id: source.workspaceId, run_id: source.runId, surface_id: null,
      created_at: source.createdAt, require_source_observed_at: false,
      signal_id_for: (index) => `semantic-${work.key}-${index}`
    });
    if (audit.mode !== 'strict' || audit.envelope.disposition !== 'admitted' ||
      audit.entries.length !== raw.signals.length || audit.entries.some((entry) => entry.disposition !== 'admitted')) {
      throw new Error(`semantic artifact admission rejected or incomplete: ${JSON.stringify(audit.entries.map((entry) => entry.reason))}`);
    }
    // Keep occurrence, inferred source time, and runtime signal IDs out of reusable proposals.
    const payload = audit.entries.map((entry) => {
      const signal = entry.signal!;
      const rawPayload = signal.raw_payload;
      return { object_kind: signal.object_kind, confidence: signal.confidence,
        matched_text: rawPayload.matched_text, distilled_fact: rawPayload.distilled_fact,
        canonical_entities: signal.canonical_entities,
        preference_profile: rawPayload.preference_profile, fact_frame: rawPayload.fact_frame,
        semantic_factor_graph: rawPayload.semantic_factor_graph,
        kind_projection: rawPayload.kind_projection };
    });
    return Object.freeze({ key: work.key, rawJson, payloadJson: JSON.stringify(payload),
      searchText: [unit.text, ...payload.map((draft) => draft.object_kind)].join("\n") });
  }
}
