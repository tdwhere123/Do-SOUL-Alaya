const SOURCE_SEMANTIC_CORRESPONDENCE_PRODUCER_REGISTRY_POLICY_VERSION = "1";
export const SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID = "alaya.source.semantic.correspondence.core.v1";
export const SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID = "alaya.source.semantic.correspondence.soul.v1";

const SOURCE_SEMANTIC_CORRESPONDENCE_PRODUCER_CAPABILITIES = ["semantic_correspondence"] as const;

type SourceSemanticCorrespondenceProducerCapability =
  (typeof SOURCE_SEMANTIC_CORRESPONDENCE_PRODUCER_CAPABILITIES)[number];

export type SourceSemanticCorrespondenceProducerRecord = Readonly<{
  readonly producer_id: string;
  readonly version: string;
  readonly capabilities: readonly SourceSemanticCorrespondenceProducerCapability[];
}>;

export function sourceSemanticCorrespondenceProducerRecord(
  producerId: string,
  extra: Omit<Partial<SourceSemanticCorrespondenceProducerRecord>, "producer_id"> = {}
): SourceSemanticCorrespondenceProducerRecord {
  return {
    producer_id: producerId,
    version: extra.version ?? "1",
    capabilities: extra.capabilities ?? SOURCE_SEMANTIC_CORRESPONDENCE_PRODUCER_CAPABILITIES
  };
}

export class SourceSemanticCorrespondenceProducerRegistry {
  readonly policy_version = SOURCE_SEMANTIC_CORRESPONDENCE_PRODUCER_REGISTRY_POLICY_VERSION;
  private readonly records: ReadonlyMap<string, SourceSemanticCorrespondenceProducerRecord>;

  constructor(records: readonly SourceSemanticCorrespondenceProducerRecord[] = PRODUCTION_RECORDS) {
    const map = new Map<string, SourceSemanticCorrespondenceProducerRecord>();
    for (const record of records) {
      map.set(recordKey(record.producer_id, record.version), record);
    }
    this.records = map;
  }

  lookup(producerId: string, version = "1"): SourceSemanticCorrespondenceProducerRecord | undefined {
    return this.records.get(recordKey(producerId, version));
  }
}

const PRODUCTION_RECORDS: readonly SourceSemanticCorrespondenceProducerRecord[] = [
  sourceSemanticCorrespondenceProducerRecord(SOURCE_SEMANTIC_CORRESPONDENCE_CORE_PRODUCER_ID),
  sourceSemanticCorrespondenceProducerRecord(SOURCE_SEMANTIC_CORRESPONDENCE_SOUL_PRODUCER_ID)
];

export const defaultSourceSemanticCorrespondenceProducerRegistry = new SourceSemanticCorrespondenceProducerRegistry();

function recordKey(producerId: string, version: string): string {
  return `${producerId}\0${version}`;
}
