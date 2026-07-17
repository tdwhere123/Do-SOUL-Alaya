import {
  SignalSourceObservationSchema,
  type CandidateMemorySignal,
  type ContextDeliveryRecord
} from "@do-soul/alaya-protocol";

type SignalSourceObservation = NonNullable<CandidateMemorySignal["source_observation"]>;

export type VerifiedDeliverySourceObservation = Omit<SignalSourceObservation, "authority"> & Readonly<{
  authority: "verified_delivery_observation";
}>;

export function createVerifiedDeliverySourceObservation(
  deliveries: readonly Readonly<ContextDeliveryRecord>[]
): VerifiedDeliverySourceObservation | null {
  let latest: VerifiedDeliverySourceObservation | null = null;
  for (const delivery of deliveries) {
    const observation = readVerifiedDeliverySourceObservation({
      observed_at: delivery.delivered_at,
      authority: "verified_delivery_observation",
      source_event_id: delivery.audit_event_id
    });
    if (observation !== null &&
        (latest === null || compareObservations(latest, observation) < 0)) {
      latest = observation;
    }
  }
  return latest;
}

export function readVerifiedDeliverySourceObservation(
  value: unknown
): VerifiedDeliverySourceObservation | null {
  const parsed = SignalSourceObservationSchema.safeParse(value);
  if (!parsed.success || parsed.data.authority !== "verified_delivery_observation") {
    return null;
  }
  return {
    observed_at: parsed.data.observed_at,
    authority: "verified_delivery_observation",
    source_event_id: parsed.data.source_event_id
  };
}

function compareObservations(
  left: VerifiedDeliverySourceObservation,
  right: VerifiedDeliverySourceObservation
): number {
  const observedAt = left.observed_at.localeCompare(right.observed_at);
  return observedAt === 0 ? left.source_event_id.localeCompare(right.source_event_id) : observedAt;
}
