import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fsyncDirectory } from "../../fill/manifest/durable-exclusive-publication.js";
import {
  MATERIALIZATION_COMMIT_NAME, MATERIALIZATION_JOURNAL_NAME,
  canonicalMaterializationJournalForCommit, parseMaterializationCommit,
  parseMaterializationJournal, readMaterializationRecord,
  type ExtractionCacheMaterializationCommit,
  type ExtractionCacheMaterializationJournal
} from "./contract.js";

export interface PersistedMaterializationTransaction {
  readonly journal?: ExtractionCacheMaterializationJournal;
  readonly commit?: ExtractionCacheMaterializationCommit;
}

export function readPersistedMaterializationTransaction(
  targetRoot: string
): PersistedMaterializationTransaction {
  const journal = readJournalIfPresent(targetRoot);
  const commitPath = join(targetRoot, MATERIALIZATION_COMMIT_NAME);
  const commit = existsSync(commitPath)
    ? parseMaterializationCommit(readMaterializationRecord(commitPath)) : undefined;
  return {
    ...(journal === undefined ? {} : { journal }),
    ...(commit === undefined ? {} : { commit })
  };
}

export function reconcileCommittedMaterializationJournal(
  targetRoot: string,
  commit: ExtractionCacheMaterializationCommit,
  loaded?: ExtractionCacheMaterializationJournal
): void {
  const journal = loaded ?? readJournalIfPresent(targetRoot);
  if (journal === undefined) return;
  if (!isDeepStrictEqual(journal, canonicalMaterializationJournalForCommit(commit))) {
    throw new Error("committed target contains an unrelated open journal");
  }
  unlinkSync(join(targetRoot, MATERIALIZATION_JOURNAL_NAME));
  fsyncDirectory(targetRoot);
}

function readJournalIfPresent(
  targetRoot: string
): ExtractionCacheMaterializationJournal | undefined {
  const path = join(targetRoot, MATERIALIZATION_JOURNAL_NAME);
  return existsSync(path)
    ? parseMaterializationJournal(readMaterializationRecord(path)) : undefined;
}
