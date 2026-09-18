import { SourceInterpretationProfileSchema } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../../runs/extraction/cache-audit/bounded-artifact-reader.js";

export function readExtractionPacketProfile(path: string | undefined) {
  return path === undefined ? undefined : SourceInterpretationProfileSchema.parse(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path, maxBytes: 1_000_000, label: "source interpretation profile" })
  ));
}
