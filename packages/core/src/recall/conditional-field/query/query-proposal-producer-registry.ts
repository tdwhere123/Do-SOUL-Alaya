import {
  QUERY_PROPOSAL_PROGRAM_KINDS,
  QUERY_PROPOSAL_TRANSPORT_LIMITS,
  tightenQueryProposalLimits,
  type QueryInterpretationProposal,
  type QueryProposalInputLimits,
  type QueryProposalProgramKind,
  type QueryProposalStructuralLimits
} from "@do-soul/alaya-protocol";

export const QUERY_PROPOSAL_PRODUCER_REGISTRY_POLICY_VERSION = "1";

export const QUERY_PROPOSAL_PRODUCER_CAPABILITIES = [
  "program",
  "conditions",
  "holes",
  "hypotheses",
  "stored_cosine_admission"
] as const;

export type QueryProposalProducerCapability = (typeof QUERY_PROPOSAL_PRODUCER_CAPABILITIES)[number];

export type QueryProposalProducerRecord = Readonly<{
  readonly producer_id: string;
  readonly version: string;
  readonly capabilities: readonly QueryProposalProducerCapability[];
  readonly allowed_grammar: readonly QueryProposalProgramKind[];
  readonly max_ast_depth?: number;
  readonly max_ast_nodes?: number;
  readonly max_total_guards?: number;
  readonly max_total_predicates?: number;
  readonly max_total_hypotheses?: number;
  readonly max_request_bytes?: number;
}>;

const FULL_GRAMMAR: readonly QueryProposalProgramKind[] = QUERY_PROPOSAL_PROGRAM_KINDS;
const FULL_CAPABILITIES: readonly QueryProposalProducerCapability[] = QUERY_PROPOSAL_PRODUCER_CAPABILITIES;

const BUILTIN_PRODUCER_IDS = [
  "alaya.query.proposal.core.v1",
  "compiler.ordinary.v1",
  "compiler.test.v1",
  "daemon.test.v1",
  "source-test",
  "discovery.test.v1",
  "stored-rpc-preparation",
  "guarded-preparation",
  "stored-test-proposal",
  "stored.cosine.pair.v1"
] as const;

function builtin(producerId: string, version = "1"): QueryProposalProducerRecord {
  return {
    producer_id: producerId,
    version,
    capabilities: FULL_CAPABILITIES,
    allowed_grammar: FULL_GRAMMAR
  };
}

const BUILTIN_RECORDS: readonly QueryProposalProducerRecord[] = [
  ...BUILTIN_PRODUCER_IDS.map((producerId) => builtin(producerId)),
  builtin("compiler.test.v1", "2")
];

export class QueryProposalProducerRegistry {
  readonly policy_version = QUERY_PROPOSAL_PRODUCER_REGISTRY_POLICY_VERSION;
  private readonly records: ReadonlyMap<string, QueryProposalProducerRecord>;

  constructor(records: readonly QueryProposalProducerRecord[] = BUILTIN_RECORDS) {
    const map = new Map<string, QueryProposalProducerRecord>();
    for (const record of records) {
      map.set(recordKey(record.producer_id, record.version), record);
    }
    this.records = map;
  }

  lookup(producerId: string, version = "1"): QueryProposalProducerRecord | undefined {
    return this.records.get(recordKey(producerId, version));
  }
}

export const defaultQueryProposalProducerRegistry = new QueryProposalProducerRegistry();

export function producerVersionOf(proposal: QueryInterpretationProposal): string {
  return proposal.producer_version ?? "1";
}

export function effectiveQueryProposalLimits(
  producer: QueryProposalProducerRecord | undefined,
  declared: QueryProposalInputLimits | undefined
): QueryProposalStructuralLimits {
  return tightenQueryProposalLimits(
    QUERY_PROPOSAL_TRANSPORT_LIMITS,
    producer === undefined
      ? undefined
      : {
        max_ast_depth: producer.max_ast_depth,
        max_ast_nodes: producer.max_ast_nodes,
        max_total_guards: producer.max_total_guards,
        max_total_predicates: producer.max_total_predicates,
        max_total_hypotheses: producer.max_total_hypotheses,
        max_request_bytes: producer.max_request_bytes
      },
    declared === undefined
      ? undefined
      : {
        max_ast_depth: declared.max_ast_depth,
        max_ast_nodes: declared.max_ast_nodes,
        max_total_guards: declared.max_total_guards,
        max_total_predicates: declared.max_total_predicates,
        max_total_hypotheses: declared.max_total_hypotheses
      }
  );
}

function recordKey(producerId: string, version: string): string {
  return `${producerId}\0${version}`;
}
