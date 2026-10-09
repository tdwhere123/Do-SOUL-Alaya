import { AlayaError, SourceInterpretationProfileSchema, SourceSemanticGenerationTaskSchema as ProtocolSourceSemanticGenerationTaskSchema } from "@do-soul/alaya-protocol";
import { readBoundedCanonicalUtf8Artifact } from "../../runs/extraction/cache-audit/bounded-artifact-reader.js";
import {
  EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration, type ExtractionGenerationInput
} from "../../runs/extraction/request-artifact.js";
import type { ParsedFlags } from "../cli-options.js";

export function readExtractionPacketProfile(path: string | undefined) {
  return path === undefined ? undefined : SourceInterpretationProfileSchema.parse(JSON.parse(
    readBoundedCanonicalUtf8Artifact({ path, maxBytes: 1_000_000, label: "source interpretation profile" })
  ));
}

export function readExtractionGeneration(flags: Pick<ParsedFlags, "extractionPacketProfile" | "extractionOpenSemantics" | "extractionSourceRevisions" | "extractionGenerationTaskJson">): ExtractionGenerationInput {
  if (flags.extractionOpenSemantics === true && flags.extractionPacketProfile !== undefined) {
    throw new AlayaError("VALIDATION", "open semantics and packet profile are mutually exclusive");
  }
  if (flags.extractionSourceRevisions !== undefined && flags.extractionOpenSemantics !== true) {
    throw new AlayaError("VALIDATION", "source revisions require explicit open semantics");
  }
  if (flags.extractionGenerationTaskJson !== undefined && flags.extractionOpenSemantics !== true) {
    throw new AlayaError("VALIDATION", "generation task requires explicit open semantics");
  }
  if (flags.extractionOpenSemantics === true) {
    const revisions = flags.extractionSourceRevisions === undefined ? undefined : JSON.parse(readBoundedCanonicalUtf8Artifact({
      path: flags.extractionSourceRevisions, maxBytes: 1_000_000, label: "source semantic revisions"
    }));
    const generation_task = flags.extractionGenerationTaskJson === undefined ? undefined : ProtocolSourceSemanticGenerationTaskSchema.parse(
      JSON.parse(readBoundedCanonicalUtf8Artifact({ path: flags.extractionGenerationTaskJson, maxBytes: 1_000_000, label: "source semantic generation task" }))
    );
    return { openSemantics: parseExtractionOpenSemanticsGeneration({ ...EXTRACTION_OPEN_SEMANTICS_GENERATION,
      ...(revisions === undefined ? {} : { revisions }),
      ...(generation_task === undefined ? {} : { generation_task }) }) };
  }
  const sourceInterpretationProfile = readExtractionPacketProfile(flags.extractionPacketProfile);
  return sourceInterpretationProfile === undefined ? {} : { sourceInterpretationProfile };
}
