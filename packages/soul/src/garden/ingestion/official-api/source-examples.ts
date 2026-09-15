import { buildOfficialApiExtractionRequest, computeOfficialApiSourceCorpusIdentity } from "./extraction-request.js";
import { buildOfficialApiSourceCorpus, OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION } from "../../triage/grounding/source-locator.js";

function exampleSourceCorpusIdentity(source: string): string {
  return computeOfficialApiSourceCorpusIdentity(buildOfficialApiSourceCorpus(source, []));
}

function phrase(text: string, occurrence?: number) {
  return occurrence === undefined ? { text } : { text, occurrence };
}

function relation(
  predicate: string,
  arguments_: readonly { readonly role: string; readonly text: string; readonly occurrence?: number }[],
  qualifiers: readonly { readonly role: string; readonly text: string; readonly occurrence?: number }[] = []
) {
  return {
    predicate: { text: predicate },
    arguments: arguments_.map((item) => ({ role: item.role, phrase: phrase(item.text, item.occurrence) })),
    qualifiers: qualifiers.map((item) => ({ role: item.role, phrase: phrase(item.text, item.occurrence) }))
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
      "interpretations": [
        {
          "assertion_id": 1,
          "relations": [
            relation(
              "opened",
              [
                { role: "agent", text: "I", occurrence: 1 },
                { role: "theme", text: "a workshop" }
              ],
              [
                { role: "event_time", text: "2020" },
                { role: "accompanying_content", text: "promised to lend tools" }
              ]
            )
          ]
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
      "interpretations": [
        {
          "assertion_id": 1,
          "relations": [
            relation(
              "borrow",
              [
                { role: "agent", text: "I" },
                { role: "theme", text: "tools" }
              ],
              [
                { role: "location", text: "in the workshop" },
                { role: "condition", text: "only on Saturdays" }
              ]
            )
          ]
        }
      ]
    }
  },
  {
    "input": buildOfficialApiExtractionRequest(
      "The exhibit opened in 2019 with the aim of helping visitors learn ceramics.", []
    ),
    "output": {
      "interpretations": [
        {
          "assertion_id": 1,
          "relations": [
            relation(
              "opened",
              [
                { role: "theme", text: "The exhibit" }
              ],
              [
                { role: "event_time", text: "2019" },
                {
                  role: "accompanying_content",
                  text: "with the aim of helping visitors learn ceramics"
                }
              ]
            )
          ]
        }
      ]
    }
  }
] as const;
