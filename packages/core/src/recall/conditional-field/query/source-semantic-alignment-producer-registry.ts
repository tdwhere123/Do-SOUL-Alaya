import {
  SOURCE_SEMANTIC_ALIGNMENT_CONTRACT, SOURCE_SEMANTIC_ALIGNMENT_SELECTION_CONTRACT
} from "@do-soul/alaya-protocol";

const SOURCE_SEMANTIC_ALIGNMENT_PRODUCER_REGISTRY_POLICY_VERSION = "1";
export const SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID = "alaya.source.semantic.alignment.core.v1";
export const SOURCE_SEMANTIC_ALIGNMENT_SOUL_PRODUCER_ID = "alaya.source.semantic.alignment.soul.v1";
export const SOURCE_SEMANTIC_ALIGNMENT_GRAPH_SYNTAX = SOURCE_SEMANTIC_ALIGNMENT_CONTRACT;
export const SOURCE_SEMANTIC_ALIGNMENT_SELECTION_SYNTAX = SOURCE_SEMANTIC_ALIGNMENT_SELECTION_CONTRACT;

const SOURCE_SEMANTIC_ALIGNMENT_PRODUCER_CAPABILITIES = ["semantic_alignment"] as const;
const SOURCE_SEMANTIC_ALIGNMENT_SYNTAXES = [
  SOURCE_SEMANTIC_ALIGNMENT_GRAPH_SYNTAX, SOURCE_SEMANTIC_ALIGNMENT_SELECTION_SYNTAX
] as const;

type SourceSemanticAlignmentProducerCapability =
  (typeof SOURCE_SEMANTIC_ALIGNMENT_PRODUCER_CAPABILITIES)[number];
export type SourceSemanticAlignmentSyntax = (typeof SOURCE_SEMANTIC_ALIGNMENT_SYNTAXES)[number];

export type SourceSemanticAlignmentProducerRecord = Readonly<{
  readonly producer_id: string;
  readonly version: string;
  readonly capabilities: readonly SourceSemanticAlignmentProducerCapability[];
  readonly syntaxes: readonly SourceSemanticAlignmentSyntax[];
}>;

export function sourceSemanticAlignmentProducerRecord(
  producerId: string,
  extra: Omit<Partial<SourceSemanticAlignmentProducerRecord>, "producer_id"> = {}
): SourceSemanticAlignmentProducerRecord {
  return {
    producer_id: producerId,
    version: extra.version ?? "1",
    capabilities: extra.capabilities ?? SOURCE_SEMANTIC_ALIGNMENT_PRODUCER_CAPABILITIES,
    syntaxes: extra.syntaxes ?? SOURCE_SEMANTIC_ALIGNMENT_SYNTAXES
  };
}

export class SourceSemanticAlignmentProducerRegistry {
  readonly policy_version = SOURCE_SEMANTIC_ALIGNMENT_PRODUCER_REGISTRY_POLICY_VERSION;
  private readonly records: ReadonlyMap<string, SourceSemanticAlignmentProducerRecord>;

  constructor(records: readonly SourceSemanticAlignmentProducerRecord[] = PRODUCTION_RECORDS) {
    const map = new Map<string, SourceSemanticAlignmentProducerRecord>();
    for (const record of records) {
      map.set(recordKey(record.producer_id, record.version), record);
    }
    this.records = map;
  }

  lookup(producerId: string, version = "1"): SourceSemanticAlignmentProducerRecord | undefined {
    return this.records.get(recordKey(producerId, version));
  }
}

const PRODUCTION_RECORDS: readonly SourceSemanticAlignmentProducerRecord[] = [
  sourceSemanticAlignmentProducerRecord(SOURCE_SEMANTIC_ALIGNMENT_CORE_PRODUCER_ID),
  sourceSemanticAlignmentProducerRecord(SOURCE_SEMANTIC_ALIGNMENT_SOUL_PRODUCER_ID)
];

export const defaultSourceSemanticAlignmentProducerRegistry = new SourceSemanticAlignmentProducerRegistry();

function recordKey(producerId: string, version: string): string {
  return `${producerId}\0${version}`;
}
