import type { AdmittedSemanticArtifact, SemanticArtifactCodec, SemanticArtifactWork,
  SemanticExtractionProfile, SemanticSourceSnapshot } from "@do-soul/alaya-protocol";
import { planOfficialApiSemanticWorkset, assertOfficialApiSemanticWorkUnit,
  type OfficialApiSemanticWorkUnit } from "./semantic-workset.js";
import { buildOfficialApiSourceRequest, parseOfficialApiExtractionRequest } from "./extraction-request.js";
import { classifyOfficialApiInterpretationResult } from "./source-interpretation-receive.js";
import { canonicalizeSemanticExtractionProfile, computeSemanticArtifactKey } from
  "./semantic-artifact-identity.js";
import { resolveExtractionCapability } from "./extraction-capability.js";
import { buildOfficialApiSourceCorpus } from "../../triage/grounding/source-locator.js";

/** Shares the source work-unit and formation owners; artifacts contain proposals, never admitted truth. */
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
      key: computeSemanticArtifactKey(unit.semanticKey, canonical),
      semanticKey: unit.semanticKey,
      requestJson: JSON.stringify(buildOfficialApiSourceRequest(unit.sourceCorpus, [unit.assertionId])),
      admissionJson: JSON.stringify({ unit, profile: canonical }),
      bindingJson: JSON.stringify(unit.binding)
    }));
  }

  public admit(source: SemanticSourceSnapshot, work: SemanticArtifactWork, rawJson: string): AdmittedSemanticArtifact {
    const { unit, profile } = JSON.parse(work.admissionJson) as {
      unit: OfficialApiSemanticWorkUnit; profile: SemanticExtractionProfile
    };
    assertOfficialApiSemanticWorkUnit(unit);
    const canonical = canonicalizeSemanticExtractionProfile(profile);
    if (computeSemanticArtifactKey(unit.semanticKey, canonical) !== work.key ||
      unit.semanticKey !== work.semanticKey ||
      unit.sourceCorpus !== buildOfficialApiSourceCorpus(source.content, [
        { role: source.trustedRole, content: source.content }
      ])) {
      throw new Error("semantic artifact source mismatch");
    }
    const request = parseOfficialApiExtractionRequest(JSON.parse(work.requestJson));
    const received = classifyOfficialApiInterpretationResult(rawJson, request, unit.sourceCorpus);
    const payload = received.located;
    return Object.freeze({ key: work.key, rawJson, payloadJson: JSON.stringify(payload),
      searchText: payload.filter((item) => item.outcome === "candidates")
        .map((item) => item.assertion_binding.text).join("\n") });
  }
}
