import { EvidenceTextDisclosuresSchema, type EvidenceTextDisclosures } from "@do-soul/alaya-protocol";
import { projectSourceDisclosure } from "../recall/runtime/source-disclosure.js";

/** The authorized evidence read has no verified original source binding. */
export function projectEvidenceRead<T extends Readonly<{ gist: string | null; excerpt: string | null }>>(
  evidence: T, evaluatedAsOf: string): Readonly<T & { text_disclosures: EvidenceTextDisclosures }> {
  const gist = projectSourceDisclosure({ material_kind: "retained_gist", evaluated_as_of: evaluatedAsOf });
  const excerpt = evidence.excerpt === null ? undefined
    : projectSourceDisclosure({ material_kind: "retained_excerpt", evaluated_as_of: evaluatedAsOf });
  const text_disclosures = EvidenceTextDisclosuresSchema.parse({ gist,
    ...(excerpt === undefined ? {} : { excerpt }), content: excerpt ?? gist });
  return { ...evidence, text_disclosures };
}
