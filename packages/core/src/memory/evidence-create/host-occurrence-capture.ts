import {
  HOST_OCCURRENCE_CONTRACT, HostCaptureIssuerSchema, bindHostOccurrenceInventory,
  canonicalJson, describeHostStructure, type FieldContractSha256, type HostCaptureIssuer,
  type HostOccurrenceInventory, type HostStructureDescriptor, type SourceAdmissionRequest
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import type { FieldFormationStores } from "./field-stores.js";

/** The composition supplies this function, never request JSON or an importer-provided issuer string. */
export type HostCaptureBinding = (request: SourceAdmissionRequest) => HostCaptureIssuer;

export function captureHostStructure(request: SourceAdmissionRequest, recordId: string, contentDigest: string,
  stores: FieldFormationStores, sha256: FieldContractSha256, issuerBinding?: HostCaptureBinding):
  Readonly<{ descriptor: HostStructureDescriptor; inventory: HostOccurrenceInventory; canonical: string }> | undefined {
  if (request.host_structure !== undefined && request.host_occurrences !== undefined) {
    throw new CoreError("VALIDATION", "host capture and retention are mutually exclusive");
  }
  const retained = stores.getStoredRecord(request.workspace_id, recordId);
  let inventory: HostOccurrenceInventory;
  if (request.host_occurrences !== undefined) {
    if (issuerBinding === undefined) throw new CoreError("VALIDATION", "host capture requires trusted admission context");
    const issuer = HostCaptureIssuerSchema.parse(issuerBinding(structuredClone(request)));
    if (issuer.workspace_id !== request.workspace_id) throw new CoreError("VALIDATION", "host issuer workspace mismatch");
    if (issuer.basis === "reported_excerpt" && request.host_occurrences.some(row =>
      row.completeness !== "excerpt" || row.author_ref !== null || row.container_ref !== null ||
      row.upstream_message_ref !== null || row.upstream_position !== null)) {
      throw new CoreError("VALIDATION", "reported excerpts cannot assert upstream completeness or identity");
    }
    inventory = bindHostOccurrenceInventory({ contract: HOST_OCCURRENCE_CONTRACT, issuer,
      occurrences: request.host_occurrences }, request.content_bytes);
  } else if (request.host_structure !== undefined) {
    const canonical = stores.getHostInventory(request.workspace_id, recordId);
    if (retained === null || canonical === null || retained.content_bytes !== request.content_bytes ||
        canonicalJson(retained.record.host_structure ?? null) !== canonicalJson(request.host_structure)) {
      throw new CoreError("VALIDATION", "host retention requires the exact retained inventory and source");
    }
    inventory = bindHostOccurrenceInventory(JSON.parse(canonical), request.content_bytes);
  } else {
    if (retained?.record.host_structure !== undefined) throw new CoreError("CONFLICT", "host inventory cannot be omitted on replay");
    return undefined;
  }
  assertCompatibleAttribution(request, inventory);
  const descriptor = describeHostStructure({ ...request, content_digest: contentDigest }, inventory, sha256);
  if (request.host_structure !== undefined && canonicalJson(descriptor) !== canonicalJson(request.host_structure)) {
    throw new CoreError("VALIDATION", "retained host structure binding is invalid");
  }
  return { descriptor, inventory, canonical: canonicalJson(inventory) };
}

function assertCompatibleAttribution(request: SourceAdmissionRequest, inventory: HostOccurrenceInventory): void {
  const attribution = request.attribution_context;
  if (attribution?.status !== "captured") return;
  for (const occurrence of inventory.occurrences) {
    for (const utterance of attribution.utterances) {
      if (occurrence.utf8_span[0] >= utterance.utf8_span[1] || occurrence.utf8_span[1] <= utterance.utf8_span[0]) continue;
      for (const [reference, legacy] of [[occurrence.author_ref, utterance.author_ref],
        [occurrence.container_ref, utterance.conversation_ref]] as const) {
        // Different scopes do not establish equality or contradiction of external identities.
        if (reference !== null && legacy !== null && reference.scope === attribution.issuer_scope && reference.id !== legacy) {
          throw new CoreError("CONFLICT", "host capture conflicts with retained attribution");
        }
      }
    }
  }
}
