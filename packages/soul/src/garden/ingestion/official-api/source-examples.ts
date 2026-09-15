import { IDENTITY_OBSERVATION_PRODUCER } from "@do-soul/alaya-protocol";
import { buildOfficialApiExtractionRequest, computeOfficialApiSourceCorpusIdentity } from "./extraction-request.js";
import { buildOfficialApiSourceCorpus, OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION } from "../../triage/grounding/source-locator.js";

function exampleSourceCorpusIdentity(source: string): string {
  return computeOfficialApiSourceCorpusIdentity(buildOfficialApiSourceCorpus(source, []));
}

function identityObservation(
  mentions: readonly string[],
  unresolved: readonly string[] = []
) {
  return {
    contract_version: 1 as const,
    producer: IDENTITY_OBSERVATION_PRODUCER,
    mentions: mentions.map((surface) => ({ surface })),
    ...(unresolved.length === 0 ? {} : {
      unresolved_spans: unresolved.map((surface) => ({ surface }))
    })
  };
}

/** Fictional source-grounded examples; never an extraction source or runtime policy. */
export const OFFICIAL_API_GROUNDED_EXAMPLES = [
  {
    "input": {
      "schema_version": 2,
      "source_locator_contract_version": OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
      "batch_contract_version": 1,
      "source_corpus_identity": exampleSourceCorpusIdentity(
        "In 2020, I opened a workshop and promised to lend tools."
      ),
      "batch_index": 0,
      "batch_count": 1,
      "source_assertions": [
        {
          "assertion_id": 1,
          "text": "User: In 2020, I opened a workshop and promised to lend tools."
        }
      ]
    },
    "output": {
      "signals": [
        {
          "object_kind": "episode",
          "confidence": 1,
          "matched_text": "In 2020, I opened a workshop and promised to lend tools.",
          "source_locator": {
            "contract_version": OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
            "kind": "assertion_catalog",
            "assertion_id": 1
          },
          "canonical_entities": ["workshop", "tools"],
          "identity_observation": identityObservation([
            "I", "opened", "a workshop", "2020", "promised", "to lend tools"
          ]),
          "temporal_projection": {
            "projection_schema_version": 1,
            "time_precision": "year",
            "time_source": "explicit",
            "event_time_start": "2020-01-01T00:00:00.000Z",
            "event_time_end": "2020-12-31T23:59:59.999Z"
          }
        }
      ]
    }
  },
  {
    "input": {
      "schema_version": 2,
      "source_locator_contract_version": OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
      "batch_contract_version": 1,
      "source_corpus_identity": exampleSourceCorpusIdentity(
        "I can borrow tools in the workshop only on Saturdays."
      ),
      "batch_index": 0,
      "batch_count": 1,
      "source_assertions": [
        {
          "assertion_id": 1,
          "text": "User: I can borrow tools in the workshop only on Saturdays."
        }
      ]
    },
    "output": {
      "signals": [
        {
          "object_kind": "open_semantic_observation",
          "confidence": 1,
          "matched_text": "I can borrow tools in the workshop only on Saturdays.",
          "source_locator": {
            "contract_version": OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
            "kind": "assertion_catalog",
            "assertion_id": 1
          },
          "canonical_entities": ["workshop", "tools"],
          "identity_observation": identityObservation(
            ["I", "can", "borrow", "tools", "in the workshop"],
            ["only on Saturdays"]
          )
        }
      ]
    }
  },
  {
    "input": buildOfficialApiExtractionRequest(
      "The exhibit opened in 2019 with the aim of helping visitors learn ceramics.", []
    ),
    "output": {
      "signals": [
        {
          "object_kind": "episode",
          "confidence": 1,
          "matched_text": "The exhibit opened in 2019 with the aim of helping visitors learn ceramics.",
          "source_locator": {
            "contract_version": OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION,
            "kind": "assertion_catalog",
            "assertion_id": 1
          },
          "canonical_entities": ["exhibit", "ceramics"],
          "identity_observation": identityObservation([
            "The exhibit",
            "opened",
            "2019",
            "with the aim of helping visitors learn ceramics"
          ]),
          "temporal_projection": {
            "projection_schema_version": 1,
            "time_precision": "year",
            "time_source": "explicit",
            "event_time_start": "2019-01-01T00:00:00.000Z",
            "event_time_end": "2019-12-31T23:59:59.999Z"
          }
        }
      ]
    }
  }
] as const;
