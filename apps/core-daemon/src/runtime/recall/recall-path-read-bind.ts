import {
  SqliteFieldCausalUsageRepo,
  SqliteRelationAssertionRepo,
  SqliteSoftAssociationPathRepo,
  SqliteTemporalPathProjectionReader,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { fieldContractSha256 } from "@do-soul/alaya-core";
import { createCausalUsageTemporalPathReader } from "./causal-usage-temporal-path-reader.js";
import {
  createPreparedTemporalRecallPathReadPorts,
  type RecallPathReadPorts
} from "./recall-path-readers.js";

export type RecallPathReadBind = "temporal";

export function resolveRecallPathReadBind(input: {
  readonly database: StorageDatabase;
  readonly pathReadBind?: RecallPathReadBind;
}): RecallPathReadBind {
  if (input.pathReadBind !== undefined) return input.pathReadBind;
  return "temporal";
}

export function createBoundRecallPathReadPorts(input: {
  readonly database: StorageDatabase;
  readonly pathReadBind?: RecallPathReadBind;
}): RecallPathReadPorts {
  resolveRecallPathReadBind(input);
  const temporal = new SqliteTemporalPathProjectionReader(
    new SqliteRelationAssertionRepo(input.database)
  );
  return createPreparedTemporalRecallPathReadPorts(
    createCausalUsageTemporalPathReader({
      base: temporal,
      usageRepo: new SqliteFieldCausalUsageRepo(input.database, fieldContractSha256)
    }),
    new SqliteSoftAssociationPathRepo(input.database)
  );
}
