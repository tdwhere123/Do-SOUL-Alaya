import { StorageTier } from "@do-soul/alaya-protocol";
import {
  DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
  DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP
} from "../../coarse-filter/coarse-candidates.js";
import {
  buildInformativeEvidenceSearchQueries
} from "../../coarse-filter/evidence/search-query-planner.js";
import { compileRecallQueryDemand } from "../../query/recall-query-demand.js";
import type { RecallQueryProbes } from "../../query/recall-query-probes.js";
import { stableStringify } from "../../../shared/stable-stringify.js";
import type {
  CharNgramConsumerFact,
  SourceProximityConsumerFact
} from "./types.js";

// Gold-surface needles are demand/search fields, not diagnostics ngrams.
export const QUERY_PROBE_RETRIEVAL_FIELDS = Object.freeze([
  "lexical_terms",
  "expanded_terms",
  "phrases",
  "date_terms",
  "object_ids",
  "evidence_refs",
  "dimensions",
  "scope_classes",
  "domain_tags"
] as const);

export function inspectCharNgramConsumer(
  probes: Readonly<RecallQueryProbes>
): CharNgramConsumerFact {
  if (!Array.isArray(probes.char_ngrams)) {
    throw new Error("char_ngrams must be compiled onto query probes");
  }
  if (demandReadsCharNgrams(probes) || searchReadsCharNgrams(probes)) {
    throw new Error("char_ngrams must not feed retrieval");
  }
  return Object.freeze({ compiled: true, retrieval_consumer: "none" });
}

export function inspectSourceProximityConsumer(): SourceProximityConsumerFact {
  // Neighbor index is the coarse-filter HOT window, not a global corpus.
  return Object.freeze({
    substrate: StorageTier.HOT,
    radius: DYNAMIC_RECALL_SOURCE_PROXIMITY_RADIUS,
    seed_cap: DYNAMIC_RECALL_SOURCE_PROXIMITY_SEED_CAP,
    admission_cap: DYNAMIC_RECALL_SOURCE_PROXIMITY_ADMISSION_CAP
  });
}

function demandReadsCharNgrams(probes: Readonly<RecallQueryProbes>): boolean {
  return stableStringify(compileRecallQueryDemand(probes)) !==
    stableStringify(compileRecallQueryDemand(stripCharNgrams(probes)));
}

function searchReadsCharNgrams(probes: Readonly<RecallQueryProbes>): boolean {
  return stableStringify(buildInformativeEvidenceSearchQueries(probes)) !==
    stableStringify(buildInformativeEvidenceSearchQueries(stripCharNgrams(probes)));
}

function stripCharNgrams(
  probes: Readonly<RecallQueryProbes>
): Readonly<RecallQueryProbes> {
  return Object.freeze({ ...probes, char_ngrams: Object.freeze([]) });
}
