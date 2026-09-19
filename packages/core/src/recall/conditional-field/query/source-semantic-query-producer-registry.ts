const SOURCE_SEMANTIC_QUERY_PRODUCER_REGISTRY_POLICY_VERSION = "1";
export const SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID = "alaya.source.semantic.query.core.v1";
export const SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID = "alaya.source.semantic.query.soul.v1";

const SOURCE_SEMANTIC_QUERY_PRODUCER_CAPABILITIES = ["semantic_query"] as const;

type SourceSemanticQueryProducerCapability =
  (typeof SOURCE_SEMANTIC_QUERY_PRODUCER_CAPABILITIES)[number];

export type SourceSemanticQueryProducerRecord = Readonly<{
  readonly producer_id: string;
  readonly version: string;
  readonly capabilities: readonly SourceSemanticQueryProducerCapability[];
}>;

export function sourceSemanticQueryProducerRecord(
  producerId: string,
  extra: Omit<Partial<SourceSemanticQueryProducerRecord>, "producer_id"> = {}
): SourceSemanticQueryProducerRecord {
  return {
    producer_id: producerId,
    version: extra.version ?? "1",
    capabilities: extra.capabilities ?? SOURCE_SEMANTIC_QUERY_PRODUCER_CAPABILITIES
  };
}

export class SourceSemanticQueryProducerRegistry {
  readonly policy_version = SOURCE_SEMANTIC_QUERY_PRODUCER_REGISTRY_POLICY_VERSION;
  private readonly records: ReadonlyMap<string, SourceSemanticQueryProducerRecord>;

  constructor(records: readonly SourceSemanticQueryProducerRecord[] = PRODUCTION_RECORDS) {
    const map = new Map<string, SourceSemanticQueryProducerRecord>();
    for (const record of records) {
      map.set(recordKey(record.producer_id, record.version), record);
    }
    this.records = map;
  }

  lookup(producerId: string, version = "1"): SourceSemanticQueryProducerRecord | undefined {
    return this.records.get(recordKey(producerId, version));
  }
}

const PRODUCTION_RECORDS: readonly SourceSemanticQueryProducerRecord[] = [
  sourceSemanticQueryProducerRecord(SOURCE_SEMANTIC_QUERY_CORE_PRODUCER_ID),
  sourceSemanticQueryProducerRecord(SOURCE_SEMANTIC_QUERY_SOUL_PRODUCER_ID)
];

export const defaultSourceSemanticQueryProducerRegistry = new SourceSemanticQueryProducerRegistry();

function recordKey(producerId: string, version: string): string {
  return `${producerId}\0${version}`;
}
