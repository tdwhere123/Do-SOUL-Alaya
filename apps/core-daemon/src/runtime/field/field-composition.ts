import type {
  CausalUsagePort,
  EffectDecisionReceipt,
  FieldContractSha256
} from "@do-soul/alaya-protocol";
import {
  fieldContractSha256,
  type EffectDecisionStore,
  type FieldFormationStores,
  type RecallFieldQuerySession
} from
  "@do-soul/alaya-core";
import type { SqliteEventLogRepo, StorageDatabase } from "@do-soul/alaya-storage";
import { createDaemonFieldRepos, type DaemonFieldRepos } from "./field-repos.js";
import { createSqliteCausalUsagePort } from "./sqlite-causal-usage-port.js";
import { createSqliteFieldFormationStores } from "./sqlite-field-formation-stores.js";
import { createSqliteFieldQuerySession } from "./sqlite-field-query-session.js";
import { createSqliteFieldProjectionLifecycle } from
  "./sqlite-field-projection-lifecycle.js";
import { createProjectionRebuildingFieldStores } from
  "./projection-rebuilding-field-stores.js";

export type DaemonFieldComposition = Readonly<{
  readonly fieldRepos: DaemonFieldRepos;
  readonly stores: FieldFormationStores;
  readonly usagePort: CausalUsagePort;
  readonly effectDecisionStore: EffectDecisionStore;
  readonly querySession: RecallFieldQuerySession;
  readonly projectionLifecycle: ReturnType<typeof createSqliteFieldProjectionLifecycle>;
}>;

export function createDaemonFieldComposition(input: Readonly<{
  readonly database: StorageDatabase;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly sha256?: FieldContractSha256;
}>): DaemonFieldComposition {
  const sha256 = input.sha256 ?? fieldContractSha256;
  const fieldRepos = createDaemonFieldRepos({
    database: input.database,
    sha256
  });
  const baseStores = createSqliteFieldFormationStores({
    repos: fieldRepos,
    database: input.database
  });
  const projectionLifecycle = createSqliteFieldProjectionLifecycle({
    generations: fieldRepos.generations,
    stores: baseStores,
    database: input.database,
    eventLog: input.eventLogRepo,
    sha256
  });
  projectionLifecycle.drainPending();
  const stores = createProjectionRebuildingFieldStores({
    delegate: baseStores,
    lifecycle: projectionLifecycle
  });
  return Object.freeze({
    fieldRepos,
    stores,
    usagePort: createSqliteCausalUsagePort({
      repo: fieldRepos.usage,
      sha256
    }),
    effectDecisionStore: createEffectDecisionStore(fieldRepos, projectionLifecycle),
    projectionLifecycle,
    querySession: createSqliteFieldQuerySession({
      generations: fieldRepos.generations,
      database: input.database,
      sha256
    })
  });
}

function createEffectDecisionStore(
  repos: DaemonFieldRepos,
  lifecycle: ReturnType<typeof createSqliteFieldProjectionLifecycle>
): EffectDecisionStore {
  return {
    insert(receipt: EffectDecisionReceipt): EffectDecisionReceipt {
      repos.effects.insert({
        schema_version: receipt.schema_version,
        request_digest: receipt.request_digest,
        workspace_id: receipt.workspace_id,
        actor_id: receipt.actor_id,
        run_id: receipt.run_id,
        delivery_id: receipt.delivery_id,
        action: receipt.action,
        target: receipt.target,
        scope: receipt.scope,
        effective_as_of: receipt.effective_as_of,
        decision: receipt.decision,
        supporting_receipt_ids_json: JSON.stringify(receipt.supporting_receipt_ids),
        supporting_proof_witnesses_json: JSON.stringify(receipt.supporting_proof_witnesses),
        governance_frontier: receipt.governance_frontier,
        policy_operator_id: receipt.policy_operator_id,
        policy_operator_version: receipt.policy_operator_version,
        recorded_at: receipt.recorded_at
      });
      lifecycle.requestRebuild(receipt.workspace_id, receipt.recorded_at);
      lifecycle.drainPending();
      return receipt;
    }
  };
}
