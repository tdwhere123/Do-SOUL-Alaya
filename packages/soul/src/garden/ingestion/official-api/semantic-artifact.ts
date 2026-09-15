import { SemanticInterpretationProposalSchema, SourceInterpretationResponseSchema,
  type AdmittedSemanticArtifact, type SemanticArtifactCodec, type SemanticArtifactWork,
  type SemanticExtractionProfile, type SemanticSourceSnapshot } from "@do-soul/alaya-protocol";
import { planOfficialApiSemanticWorkset, assertOfficialApiSemanticWorkUnit,
  type OfficialApiSemanticWorkUnit } from "./semantic-workset.js";
import { buildOfficialApiSourceRequest, parseOfficialApiExtractionRequest } from "./extraction-request.js";
import { classifyOfficialApiInterpretationResult } from "./source-interpretation-receive.js";
import { canonicalizeSemanticExtractionProfile, computeSemanticArtifactKey } from
  "./semantic-artifact-identity.js";
import { resolveExtractionCapability } from "./extraction-capability.js";
import { buildOfficialApiSourceCorpus } from "../../triage/grounding/source-locator.js";

/** Reusable proposals and current occurrence binding share the interpretation locator. */
export class OfficialApiSemanticArtifactCodec implements SemanticArtifactCodec {
  public plan(source: SemanticSourceSnapshot, profile: SemanticExtractionProfile): readonly SemanticArtifactWork[] {
    const canonical = canonicalizeSemanticExtractionProfile(profile);
    if (resolveExtractionCapability(canonical.capability).materializer !== "official_api_signals") {
      throw new Error(`extraction capability ${canonical.capability} is not official-api materializable`);
    }
    const units = planOfficialApiSemanticWorkset(source.content, [
      { role: source.trustedRole, content: source.content }
    ]).units;
    return units.map((unit) => ({
      key: computeSemanticArtifactKey(unit.semanticKey, canonical), semanticKey: unit.semanticKey,
      requestJson: JSON.stringify(buildOfficialApiSourceRequest(unit.sourceCorpus, [unit.assertionId])),
      admissionJson: JSON.stringify({ unit, profile: canonical }), bindingJson: JSON.stringify(unit.binding)
    }));
  }

  public admit(source: SemanticSourceSnapshot, work: SemanticArtifactWork, rawJson: string): AdmittedSemanticArtifact {
    const unit = this.currentUnit(source, work);
    classifyOfficialApiInterpretationResult(rawJson,
      parseOfficialApiExtractionRequest(JSON.parse(work.requestJson)), unit.sourceCorpus);
    const response = SourceInterpretationResponseSchema.parse(JSON.parse(rawJson));
    const proposal = SemanticInterpretationProposalSchema.parse({
      contract: "semantic-interpretation-proposal-v1",
      relations: response.interpretations.find((entry) => entry.assertion_id === unit.assertionId)?.relations ?? []
    });
    return Object.freeze({ key: work.key, rawJson, requestJson: work.requestJson,
      payloadJson: JSON.stringify(proposal), searchText: proposal.relations.length === 0 ? "" : unit.text });
  }

  public bind(source: SemanticSourceSnapshot, work: SemanticArtifactWork,
    artifact: AdmittedSemanticArtifact): SemanticArtifactWork {
    const unit = this.currentUnit(source, work);
    if (artifact.key !== work.key) throw new Error("semantic artifact binding key mismatch");
    const parsed = SemanticInterpretationProposalSchema.safeParse(JSON.parse(artifact.payloadJson));
    // Previously stored located interpretations are read from their original raw
    // single-assertion response. Never transfer cached spans or reinterpret signals.
    const legacy = parsed.success ? null : SourceInterpretationResponseSchema.parse(JSON.parse(artifact.rawJson));
    if (legacy !== null && legacy.interpretations.length > 1) {
      throw new Error("historical semantic proposal has ambiguous request provenance");
    }
    const relations = parsed.success ? parsed.data.relations : legacy!.interpretations[0]?.relations ?? [];
    const request = parseOfficialApiExtractionRequest(JSON.parse(work.requestJson));
    const empty = parsed.success ? relations.length === 0 : legacy!.interpretations.length === 0;
    const received = classifyOfficialApiInterpretationResult(JSON.stringify({ interpretations: empty ? [] : [
      { assertion_id: unit.assertionId, relations }
    ] }), request, unit.sourceCorpus);
    return { ...work, bindingJson: JSON.stringify({ ...unit.binding, interpretations: received.located }) };
  }

  private currentUnit(source: SemanticSourceSnapshot, work: SemanticArtifactWork) {
    const { unit, profile } = JSON.parse(work.admissionJson) as {
      unit: OfficialApiSemanticWorkUnit; profile: SemanticExtractionProfile
    };
    assertOfficialApiSemanticWorkUnit(unit);
    if (computeSemanticArtifactKey(unit.semanticKey, canonicalizeSemanticExtractionProfile(profile)) !== work.key ||
      unit.semanticKey !== work.semanticKey || unit.sourceCorpus !== buildOfficialApiSourceCorpus(source.content, [
        { role: source.trustedRole, content: source.content }
      ]) || work.requestJson !== JSON.stringify(buildOfficialApiSourceRequest(unit.sourceCorpus, [unit.assertionId])) ||
      work.bindingJson !== JSON.stringify(unit.binding)) {
      throw new Error("semantic artifact source mismatch");
    }
    return unit;
  }
}
