import { z } from "zod";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { SourceInterpretationResponseEnvelopeSchema } from "@do-soul/alaya-protocol";
import { receiveOfficialApiSourceInterpretations,
  type OfficialApiExtractionRequest } from "@do-soul/alaya-soul";
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
export const SourceInterpretationAnchorBindingSchema = z.object({
  interpretation_index: z.number().int().nonnegative(),
  interpretation_sha256: Sha256Schema,
  source_assertion_id: z.number().int().positive(),
  source_assertion_sha256: Sha256Schema
}).strict().readonly();

interface InterpretationAnchorInput {
  readonly sourceRawJson: string;
  readonly primaryRawJson: string;
  readonly sourceCorpus: string;
  readonly request: OfficialApiExtractionRequest;
  readonly assertionIds: readonly number[];
}

// Current receipts bind original interpretation ordinals to the same source
// catalog. They never reinterpret historical draft locators or rewrite raw bytes.
export function bindSourceInterpretationAnchors(input: InterpretationAnchorInput) {
  const source = receive(input.sourceRawJson, input);
  const primary = receive(input.primaryRawJson, input);
  const envelope = SourceInterpretationResponseEnvelopeSchema.parse(JSON.parse(input.sourceRawJson));
  const allowed = new Set(input.assertionIds);
  const covered = new Set(primary.located.filter((entry) => entry.outcome === "candidates")
    .map((entry) => entry.assertion_binding.assertion_id));
  if (input.assertionIds.some((id) => covered.has(id))) {
    throw new Error("source assertion supplement target is no longer a primary-gap assertion");
  }
  const located = new Map(source.located.map((entry) => [entry.assertion_binding.assertion_id, entry]));
  const selected = envelope.interpretations.flatMap((entry, index) => {
    if (!allowed.has(entry.assertion_id)) return [];
    const binding = located.get(entry.assertion_id);
    if (binding?.outcome !== "candidates" || entry.relations.length === 0) {
      throw new Error("source assertion supplement anchor has no admitted interpretation");
    }
    const assertionHash = digest(binding.assertion_binding.text);
    return [{ entry, binding: {
      interpretation_index: index,
      interpretation_sha256: digest(JSON.stringify(entry)),
      source_assertion_id: entry.assertion_id,
      source_assertion_sha256: assertionHash
    } satisfies z.infer<typeof SourceInterpretationAnchorBindingSchema> }];
  });
  const ids = [...new Set(selected.map(({ entry }) => entry.assertion_id))].sort((a, b) => a - b);
  if (!isDeepStrictEqual(ids, input.assertionIds)) {
    throw new Error("source assertion supplement current request anchor mismatch");
  }
  const bindings = selected.map(({ binding }) => binding);
  return { bindings, selected: selected.map(({ entry }) => entry) };
}

function receive(rawJson: string, input: InterpretationAnchorInput) {
  const receipt = receiveOfficialApiSourceInterpretations(rawJson, input.request, {
    sourceCorpus: input.sourceCorpus, artifactKey: digest(rawJson)
  });
  if (receipt.status !== "complete") {
    throw new Error("source assertion supplement interpretation source admission failed");
  }
  return receipt;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
