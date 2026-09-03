import { createHash } from "node:crypto";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import { mintOfficialApiAssertionWork } from "./extraction-request.js";
import {
  buildOfficialApiSourceAssertions,
  buildOfficialApiSourceCorpus,
  OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION
} from "../../triage/grounding/source-locator.js";
import { indexSourceAssertions } from
  "../../triage/grounding/source-locator/assertion-catalog.js";
import { collectSourceRoleMarkers } from
  "../../triage/grounding/source-role/marker.js";
import {
  demultiplexTransportPack,
  planTurnTransportPacks,
  type DemultiplexRejection,
  type TransportPack,
  type TransportPackPlan,
  type TransportPackPolicy
} from "./transport-pack.js";
export type { TransportPack, TransportPackPlan, TransportPackPolicy };
import {
  ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID,
  ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION,
  computeAssertionSemanticKey,
  digestSourceText,
  resolveAssertionSemanticContext,
  type AssertionSemanticIdentityWitness,
  type AssertionSourceBinding
} from "../../triage/grounding/source-locator/assertion-semantic-identity.js";
import { computeOfficialApiSourceCorpusIdentity } from "./extraction-request.js";

export const OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION = 1;

export interface OfficialApiSemanticWorkUnit {
  readonly semanticKey: string;
  readonly assertionId: number;
  readonly text: string;
  readonly binding: AssertionSourceBinding;
  readonly sourceCorpus?: string;
  readonly semanticIdentity?: AssertionSemanticIdentityWitness;
}

interface VerifiedOfficialApiSemanticWorkUnit extends OfficialApiSemanticWorkUnit {
  readonly sourceCorpus: string;
  readonly semanticIdentity: AssertionSemanticIdentityWitness;
}

export interface OfficialApiSemanticWorkset {
  readonly contract_version: typeof OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION;
  readonly workset_digest: string;
  readonly units: readonly OfficialApiSemanticWorkUnit[];
}

interface PlannedOfficialApiSemanticWorkset extends OfficialApiSemanticWorkset {
  readonly units: readonly VerifiedOfficialApiSemanticWorkUnit[];
}

export type OfficialApiTransportBatchSize = 8 | 16 | 24 | 32;

export function planOfficialApiSemanticWorkset(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  datasetRevision?: string
): PlannedOfficialApiSemanticWorkset {
  const sourceCorpus = buildOfficialApiSourceCorpus(turnContent, messages);
  const catalog = buildOfficialApiSourceAssertions(sourceCorpus);
  const byId = new Map(catalog.map((assertion) => [assertion.assertion_id, assertion]));
  const work = mintOfficialApiAssertionWork(turnContent, messages, datasetRevision);
  const units = work.map(({ binding, semanticIdentity }) => {
    const assertion = byId.get(binding.locator.assertion_id);
    if (assertion === undefined) {
      throw new TypeError("semantic workset binding is missing from the catalog");
    }
    return {
      semanticKey: binding.semanticKey,
      assertionId: binding.locator.assertion_id,
      text: assertion.text,
      sourceCorpus,
      semanticIdentity,
      binding
    };
  });
  return freezeWorkset(units);
}

export function officialApiSemanticWorksetFromUnits(
  units: readonly OfficialApiSemanticWorkUnit[]
): OfficialApiSemanticWorkset {
  for (const unit of units) assertOfficialApiSemanticWorkUnit(unit);
  return freezeWorkset(units);
}

export function assertOfficialApiSemanticWorkUnit(
  unit: OfficialApiSemanticWorkUnit
): asserts unit is VerifiedOfficialApiSemanticWorkUnit {
  if (unit.sourceCorpus === undefined || unit.semanticIdentity === undefined) {
    throw new TypeError("semantic work unit is missing its v2 identity witness");
  }
  const witness = unit.semanticIdentity;
  const indexed = indexSourceAssertions(unit.sourceCorpus).find((item) =>
    item.assertion_id === unit.assertionId);
  const markers = collectSourceRoleMarkers(unit.sourceCorpus);
  const trustedRole = markers.filter((marker) => marker.start <= (indexed?.start ?? -1)).at(-1)?.role;
  const sentence = indexed === undefined ? "" : unit.sourceCorpus.slice(
    indexed.sentence.start, indexed.sentence.end
  );
  const semanticContext = indexed === undefined ? "" : resolveAssertionSemanticContext(
    indexed.text,
    sentence.includes(indexed.text) ? sentence : indexed.text,
    unit.sourceCorpus.slice(Math.max(0, indexed.sentence.start - 512), indexed.sentence.start)
  );
  if (witness.contractId !== ASSERTION_SEMANTIC_IDENTITY_CONTRACT_ID ||
      witness.contractVersion !== ASSERTION_SEMANTIC_IDENTITY_CONTRACT_VERSION ||
      witness.formationContractVersion !== OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION ||
      indexed?.text !== unit.text || trustedRole !== witness.trustedRole ||
      semanticContext !== witness.semanticContext || witness.exactText !== unit.text ||
      computeAssertionSemanticKey(witness) !== unit.semanticKey) {
    throw new TypeError("semantic work unit has an invalid v2 identity witness");
  }
  if (unit.binding.semanticKey !== unit.semanticKey ||
      unit.binding.locator.assertion_id !== unit.assertionId ||
      unit.binding.locator.start !== indexed.start || unit.binding.locator.end !== indexed.end ||
      unit.binding.assertionTextDigest !== digestSourceText(unit.text) ||
      unit.binding.sourceTextDigest !== digestSourceText(unit.sourceCorpus) ||
      unit.binding.sourceCorpusIdentity !== computeOfficialApiSourceCorpusIdentity(unit.sourceCorpus)) {
    throw new TypeError("semantic work unit source binding is invalid");
  }
}

export function planOfficialApiTransport(
  workset: OfficialApiSemanticWorkset,
  policy: TransportPackPolicy | { readonly kind: "reference_batch"; readonly assertionsPerPack: OfficialApiTransportBatchSize }
): TransportPackPlan {
  return planTurnTransportPacks(
    workset.units.map((unit) => ({
      semanticKey: unit.semanticKey,
      assertionId: unit.assertionId,
      text: unit.text
    })),
    policy.kind === "reference_batch"
      ? { kind: "reference_batch", assertionsPerPack: policy.assertionsPerPack }
      : policy
  );
}

export function materializeOfficialApiTransportResponse(
  pack: TransportPack,
  entries: readonly { readonly semanticKey?: string; readonly assertionId?: number }[]
): { readonly admittedKeys: readonly string[]; readonly rejections: readonly DemultiplexRejection[] } {
  return demultiplexTransportPack(pack, entries);
}

function freezeWorkset<T extends OfficialApiSemanticWorkUnit>(
  units: readonly T[]
): OfficialApiSemanticWorkset & { readonly units: readonly T[] } {
  const uniqueKeys = [...new Set(units.map((unit) => unit.semanticKey))].sort();
  const worksetDigest = createHash("sha256")
    .update(String(OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION), "utf8")
    .update("\u0000", "utf8")
    .update(uniqueKeys.join("\n"), "utf8")
    .digest("hex");
  return Object.freeze({
    contract_version: OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION,
    workset_digest: worksetDigest,
    units: Object.freeze([...units])
  });
}
