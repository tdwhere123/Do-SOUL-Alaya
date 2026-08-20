import { fieldContractSha256 } from "@do-soul/alaya-core";
import type { FieldContractSha256 } from "@do-soul/alaya-protocol";
import {
  SqliteFieldCausalUsageRepo,
  SqliteFieldDerivationJobRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteFieldFactorRepo,
  SqliteFieldProjectionGenerationRepo,
  SqliteFieldProofEffectRepo,
  SqliteFieldSourceRecordRepo,
  SqliteFieldSourceSpanRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";

export type DaemonFieldRepos = Readonly<{
  readonly records: SqliteFieldSourceRecordRepo;
  readonly spans: SqliteFieldSourceSpanRepo;
  readonly factors: SqliteFieldFactorRepo;
  readonly jobs: SqliteFieldDerivationJobRepo;
  readonly generations: SqliteFieldProjectionGenerationRepo;
  readonly erase: SqliteFieldEraseBarrierRepo;
  readonly usage: SqliteFieldCausalUsageRepo;
  readonly effects: SqliteFieldProofEffectRepo;
}>;

export function createDaemonFieldRepos(input: Readonly<{
  readonly database: StorageDatabase;
  readonly sha256?: FieldContractSha256;
}>): DaemonFieldRepos {
  const sha256 = input.sha256 ?? fieldContractSha256;
  return Object.freeze({
    records: new SqliteFieldSourceRecordRepo(input.database, sha256),
    spans: new SqliteFieldSourceSpanRepo(input.database, sha256),
    factors: new SqliteFieldFactorRepo(input.database, sha256),
    jobs: new SqliteFieldDerivationJobRepo(input.database, sha256),
    generations: new SqliteFieldProjectionGenerationRepo(input.database, sha256),
    erase: new SqliteFieldEraseBarrierRepo(input.database, sha256),
    usage: new SqliteFieldCausalUsageRepo(input.database, sha256),
    effects: new SqliteFieldProofEffectRepo(input.database, sha256)
  });
}
