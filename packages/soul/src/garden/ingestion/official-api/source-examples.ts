import { buildOfficialApiExtractionRequest, computeOfficialApiSourceCorpusIdentity } from "./extraction-request.js";
import { buildOfficialApiSourceCorpus, OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION } from "../../triage/grounding/source-locator.js";

function exampleSourceCorpusIdentity(source: string): string {
  return computeOfficialApiSourceCorpusIdentity(buildOfficialApiSourceCorpus(source, []));
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
          "canonical_entities": [
            "workshop",
            "tools"
          ],
          "semantic_factor_graph": {
            "schema_version": 2,
            "source_kind": "evidence",
            "factors": [
              {
                "factor_id": "speaker",
                "surface": "I",
                "semantic_identity": "i"
              },
              {
                "factor_id": "open",
                "surface": "opened",
                "semantic_identity": "open"
              },
              {
                "factor_id": "workshop",
                "surface": "a workshop",
                "semantic_identity": "workshop"
              },
              {
                "factor_id": "year",
                "surface": "2020",
                "semantic_identity": "2020"
              },
              {
                "factor_id": "promise",
                "surface": "promised",
                "semantic_identity": "promise"
              },
              {
                "factor_id": "content",
                "surface": "to lend tools",
                "semantic_identity": "to lend tools"
              }
            ],
            "variables": [],
            "result_variable_ids": [],
            "propositions": [
              {
                "proposition_id": "opening",
                "predicate_factor_id": "open",
                "arguments": [
                  {
                    "position": 0,
                    "binding_identity": "opener",
                    "reference_kind": "factor",
                    "reference_id": "speaker"
                  },
                  {
                    "position": 1,
                    "binding_identity": "facility",
                    "reference_kind": "factor",
                    "reference_id": "workshop"
                  },
                  {
                    "position": 2,
                    "binding_identity": "time",
                    "reference_kind": "factor",
                    "reference_id": "year"
                  }
                ]
              },
              {
                "proposition_id": "commitment",
                "predicate_factor_id": "promise",
                "arguments": [
                  {
                    "position": 0,
                    "binding_identity": "promiser",
                    "reference_kind": "factor",
                    "reference_id": "speaker"
                  },
                  {
                    "position": 1,
                    "binding_identity": "content",
                    "reference_kind": "factor",
                    "reference_id": "content"
                  },
                  {
                    "position": 2,
                    "binding_identity": "time",
                    "reference_kind": "factor",
                    "reference_id": "year"
                  }
                ]
              }
            ]
          },
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
          "canonical_entities": [
            "workshop",
            "tools"
          ],
          "semantic_factor_graph": {
            "schema_version": 2,
            "source_kind": "evidence",
            "factors": [
              {
                "factor_id": "speaker",
                "surface": "I",
                "semantic_identity": "i"
              },
              {
                "factor_id": "modality",
                "surface": "can",
                "semantic_identity": "can"
              },
              {
                "factor_id": "borrow",
                "surface": "borrow",
                "semantic_identity": "borrow"
              },
              {
                "factor_id": "tools",
                "surface": "tools",
                "semantic_identity": "tools"
              },
              {
                "factor_id": "place",
                "surface": "in the workshop",
                "semantic_identity": "in the workshop"
              },
              {
                "factor_id": "condition",
                "surface": "only on Saturdays",
                "semantic_identity": "only on saturdays"
              }
            ],
            "variables": [],
            "result_variable_ids": [],
            "propositions": [
              {
                "proposition_id": "access",
                "predicate_factor_id": "borrow",
                "arguments": [
                  {
                    "position": 0,
                    "binding_identity": "borrower",
                    "reference_kind": "factor",
                    "reference_id": "speaker"
                  },
                  {
                    "position": 1,
                    "binding_identity": "modality",
                    "reference_kind": "factor",
                    "reference_id": "modality"
                  },
                  {
                    "position": 2,
                    "binding_identity": "resource",
                    "reference_kind": "factor",
                    "reference_id": "tools"
                  },
                  {
                    "position": 3,
                    "binding_identity": "location",
                    "reference_kind": "factor",
                    "reference_id": "place"
                  },
                  {
                    "position": 4,
                    "binding_identity": "condition",
                    "reference_kind": "factor",
                    "reference_id": "condition"
                  }
                ]
              }
            ]
          }
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
          "semantic_factor_graph": {
            "schema_version": 2,
            "source_kind": "evidence",
            "factors": [
              {
                "factor_id": "exhibit",
                "surface": "The exhibit",
                "semantic_identity": "the exhibit"
              },
              {
                "factor_id": "open",
                "surface": "opened",
                "semantic_identity": "open"
              },
              {
                "factor_id": "year",
                "surface": "2019",
                "semantic_identity": "2019"
              },
              {
                "factor_id": "aim",
                "surface": "with the aim of helping visitors learn ceramics",
                "semantic_identity": "with the aim of helping visitors learn ceramics"
              }
            ],
            "variables": [],
            "result_variable_ids": [],
            "propositions": [
              {
                "proposition_id": "opening",
                "predicate_factor_id": "open",
                "arguments": [
                  {
                    "position": 0,
                    "binding_identity": "theme",
                    "reference_kind": "factor",
                    "reference_id": "exhibit"
                  },
                  {
                    "position": 1,
                    "binding_identity": "time",
                    "reference_kind": "factor",
                    "reference_id": "year"
                  },
                  {
                    "position": 2,
                    "binding_identity": "accompanying_aim",
                    "reference_kind": "factor",
                    "reference_id": "aim"
                  }
                ]
              }
            ]
          },
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
