import { dirname, resolve } from "node:path";
import { AlayaError } from "@do-soul/alaya-protocol";
import { isDeepStrictEqual } from "node:util";
import { canonicalPath, canonicalPathsOverlap } from "../../fs/opened-contained-path.js";
import { inspectSourceRecordsArtifact, type SourceRecordsDataset, type SourceRecordsMessage } from "./contract.js";
import { createLongMemEvalTaskPersonaPolicy, LongMemEvalTaskPersonaPolicySchema,
  longMemEvalPersonaSourceVersion, type LongMemEvalPersonaSuccessor } from
  "../../../datasets/longmemeval/ingestion/task-persona.js";
import type { LoadedLongMemEvalDataset } from "../../../datasets/longmemeval/ingestion/fetch.js";

export type PersonaSuccessorInput = Readonly<{ policy: string; parentSnapshotPath: string }>;

/** Read the entire parent's sealed membership without opening or modifying its DB.
 * The ordinary import owner creates a fresh snapshot, never a subset seal over it. */
export function preparePersonaSuccessor(input: PersonaSuccessorInput, options: {
  loaded: LoadedLongMemEvalDataset; dataset: SourceRecordsDataset;
  recordedAt: string; snapshotPath: string; dataDirRoot: string;
}) {
  const policy = LongMemEvalTaskPersonaPolicySchema.parse(input.policy);
  const persona = createLongMemEvalTaskPersonaPolicy(options.loaded);
  const parentSnapshot = resolve(input.parentSnapshotPath);
  const protectedRoot = canonicalPath(dirname(parentSnapshot));
  if ([options.snapshotPath, options.dataDirRoot].some(output =>
    canonicalPathsOverlap(canonicalPath(output), protectedRoot))) {
    throw new AlayaError("CONFLICT", "persona successor outputs must be outside the retained parent directory");
  }
  const predecessors = new Map<string, SourceRecordsMessage>();
  const parent = inspectSourceRecordsArtifact(parentSnapshot, message => {
    if (predecessors.has(message.message_id)) throw new AlayaError("CONFLICT", "persona parent repeats a logical source identity");
    predecessors.set(message.message_id, message);
  });
  if (!isDeepStrictEqual(parent.manifest.dataset, options.dataset) ||
      Date.parse(options.recordedAt) <= Date.parse(parent.manifest.recorded_at)) {
    throw new AlayaError("CONFLICT", "persona successor requires the same complete dataset window and a later recorded_at");
  }
  const binding: LongMemEvalPersonaSuccessor = {
    policy, parent_snapshot: parentSnapshot, parent_manifest_sha256: parent.manifest.manifest_sha256,
    source_version: longMemEvalPersonaSourceVersion(parent.manifest.manifest_sha256, options.recordedAt)
  };
  if ([...predecessors.values()].some(row => row.record.source_version === binding.source_version ||
      Date.parse(row.record.recorded_at) >= Date.parse(options.recordedAt))) {
    throw new AlayaError("CONFLICT", "persona successor requires new source versions and later recorded_at for every predecessor");
  }
  return { binding, persona, predecessors,
    assertUnchanged() {
      if (inspectSourceRecordsArtifact(parentSnapshot).manifest.manifest_sha256 !== binding.parent_manifest_sha256) {
        throw new AlayaError("CONFLICT", "persona parent changed during successor preparation");
      }
    }
  };
}
export type PreparedPersonaSuccessor = ReturnType<typeof preparePersonaSuccessor>;

export function personaPredecessor(successor: PreparedPersonaSuccessor, coordinates: {
  questionId: string; sessionId: string; sessionIndex: number; roundIndex: number;
  messageId: string; messageIndex: number; role: string;
}): SourceRecordsMessage["record"] {
  const row = successor.predecessors.get(coordinates.messageId);
  if (row === undefined || row.question_id !== coordinates.questionId || row.session_id !== coordinates.sessionId ||
      row.session_index !== coordinates.sessionIndex || row.round_index !== coordinates.roundIndex ||
      row.message_index !== coordinates.messageIndex || row.role !== coordinates.role) {
    throw new AlayaError("CONFLICT", "persona predecessor differs from original message coordinates");
  }
  return row.record;
}
