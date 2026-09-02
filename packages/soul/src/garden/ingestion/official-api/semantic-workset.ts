import { createHash } from "node:crypto";
import type { ConversationMessage } from "@do-soul/alaya-protocol";
import { mintOfficialApiAssertionBindings } from "./extraction-request.js";
import {
  buildOfficialApiSourceAssertions,
  buildOfficialApiSourceCorpus
} from "../../triage/grounding/source-locator.js";
import {
  demultiplexTransportPack,
  planTurnTransportPacks,
  type DemultiplexRejection,
  type TransportPack,
  type TransportPackPlan,
  type TransportPackPolicy
} from "./transport-pack.js";
export type { TransportPack, TransportPackPlan };
import type { AssertionSourceBinding } from
  "../../triage/grounding/source-locator/assertion-semantic-identity.js";

export const OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION = 1;

export interface OfficialApiSemanticWorkUnit {
  readonly semanticKey: string;
  readonly assertionId: number;
  readonly text: string;
  readonly binding: AssertionSourceBinding;
}

export interface OfficialApiSemanticWorkset {
  readonly contract_version: typeof OFFICIAL_API_SEMANTIC_WORKSET_CONTRACT_VERSION;
  readonly workset_digest: string;
  readonly units: readonly OfficialApiSemanticWorkUnit[];
}

export type OfficialApiTransportBatchSize = 8 | 16 | 24 | 32;

export function planOfficialApiSemanticWorkset(
  turnContent: string,
  messages: readonly Pick<ConversationMessage, "role" | "content">[],
  datasetRevision?: string
): OfficialApiSemanticWorkset {
  const catalog = buildOfficialApiSourceAssertions(
    buildOfficialApiSourceCorpus(turnContent, messages)
  );
  const byId = new Map(catalog.map((assertion) => [assertion.assertion_id, assertion]));
  const bindings = mintOfficialApiAssertionBindings(turnContent, messages, datasetRevision);
  const units = bindings.map((binding) => {
    const assertion = byId.get(binding.locator.assertion_id);
    if (assertion === undefined) {
      throw new TypeError("semantic workset binding is missing from the catalog");
    }
    return {
      semanticKey: binding.semanticKey,
      assertionId: binding.locator.assertion_id,
      text: assertion.text,
      binding
    };
  });
  return freezeWorkset(units);
}

export function officialApiSemanticWorksetFromUnits(
  units: readonly OfficialApiSemanticWorkUnit[]
): OfficialApiSemanticWorkset {
  return freezeWorkset(units);
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

function freezeWorkset(
  units: readonly OfficialApiSemanticWorkUnit[]
): OfficialApiSemanticWorkset {
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
