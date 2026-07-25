import {
  RecallCandidateObjectKindSchema,
  type ContextDeliveryRecord,
  type SoulContextObjectIdentity,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";

export class TrustStateInvalidUsageProofError extends Error {
  public readonly code = "VALIDATION" as const;

  public constructor(message: string) {
    super(message);
    this.name = "TrustStateInvalidUsageProofError";
  }
}

export function validateUsageProofAgainstDelivery(
  record: Readonly<UsageProofRecord>,
  delivery: Readonly<ContextDeliveryRecord>
): void {
  validateUsedObjects(record, delivery);
  validatePerAnchorUsage(record, delivery);
}

function validateUsedObjects(
  record: Readonly<UsageProofRecord>,
  delivery: Readonly<ContextDeliveryRecord>
): void {
  if (record.used_objects === undefined) {
    for (const objectId of record.used_object_ids) {
      assertDeliveredIdentity(delivery, {
        object_id: objectId,
        object_kind: "memory_entry"
      }, true);
    }
    return;
  }

  assertIdProjectionMatches(record);
  for (const object of record.used_objects) {
    assertDeliveredIdentity(delivery, object, false);
  }
}

function validatePerAnchorUsage(
  record: Readonly<UsageProofRecord>,
  delivery: Readonly<ContextDeliveryRecord>
): void {
  const usedIdentityKeys = resolveUsedIdentityKeys(record);
  for (const usage of record.per_anchor_usage ?? []) {
    const identity = {
      object_id: usage.object_id,
      object_kind: usage.object_kind ?? "memory_entry"
    };
    assertDeliveredIdentity(delivery, identity, record.used_objects === undefined);
    if (record.usage_state === "used" && !usedIdentityKeys.has(identityKey(identity))) {
      throw new TrustStateInvalidUsageProofError(
        `Per-anchor usage references object identity that was not reported as used: ${identity.object_kind}:${identity.object_id}`
      );
    }
  }
}

function assertDeliveredIdentity(
  delivery: Readonly<ContextDeliveryRecord>,
  identity: Readonly<SoulContextObjectIdentity>,
  legacyProof: boolean
): void {
  if (!isSupportedUsageObjectKind(identity.object_kind)) {
    throwUndelivered(identity);
  }
  if (delivery.delivered_objects === undefined) {
    if (
      identity.object_kind === "memory_entry" &&
      delivery.delivered_object_ids.includes(identity.object_id)
    ) {
      return;
    }
    throwUndelivered(identity);
  }

  const matches = delivery.delivered_objects.filter(
    (object) => object.object_id === identity.object_id
  );
  const delivered = legacyProof
    ? matches.length === 1 && matches[0]?.object_kind === "memory_entry"
    : matches.some((object) => object.object_kind === identity.object_kind);
  if (!delivered) throwUndelivered(identity);
}

function isSupportedUsageObjectKind(objectKind: string): boolean {
  return RecallCandidateObjectKindSchema.safeParse(objectKind).success;
}

function assertIdProjectionMatches(record: Readonly<UsageProofRecord>): void {
  const ids = [...new Set(record.used_object_ids)].sort();
  const projected = [
    ...new Set(record.used_objects?.map((object) => object.object_id) ?? [])
  ].sort();
  if (ids.join("\0") !== projected.join("\0")) {
    throw new TrustStateInvalidUsageProofError(
      "used_object_ids must equal the object-id projection of used_objects."
    );
  }
}

function resolveUsedIdentityKeys(record: Readonly<UsageProofRecord>): ReadonlySet<string> {
  const identities = record.used_objects ??
    record.used_object_ids.map((objectId) => ({
      object_id: objectId,
      object_kind: "memory_entry"
    }));
  return new Set(identities.map(identityKey));
}

function identityKey(identity: Readonly<SoulContextObjectIdentity>): string {
  return `${identity.object_kind}\0${identity.object_id}`;
}

function throwUndelivered(identity: Readonly<SoulContextObjectIdentity>): never {
  throw new TrustStateInvalidUsageProofError(
    `Usage proof references object identity that was not delivered: ${identity.object_kind}:${identity.object_id}`
  );
}
