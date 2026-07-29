import {
  ConsolidationTriggerBudgetSchema,
  type ConsolidationTriggerBudget,
  type ConsolidationTriggerSource
} from "@do-soul/alaya-protocol";
import type { ConsolidationBudgetStorePort } from "@do-soul/alaya-core";

export class SqliteConsolidationBudgetStore implements ConsolidationBudgetStorePort {
  private readonly findStatement;
  private readonly upsertStatement;

  public constructor(connection: { prepare(sql: string): SqlitePreparedStatement }) {
    this.findStatement = connection.prepare(`
      SELECT trigger_id, trigger_source, governance_subject, source_object_ref,
             max_attempts_within_window, attempts_used, cooldown_until
      FROM consolidation_trigger_budgets
      WHERE trigger_source = ?
      ORDER BY cooldown_until DESC
      LIMIT 1
    `);
    this.upsertStatement = connection.prepare(`
      INSERT INTO consolidation_trigger_budgets (
        trigger_id, trigger_source, governance_subject, source_object_ref,
        max_attempts_within_window, attempts_used, cooldown_until
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trigger_id) DO UPDATE SET
        trigger_source = excluded.trigger_source,
        governance_subject = excluded.governance_subject,
        source_object_ref = excluded.source_object_ref,
        max_attempts_within_window = excluded.max_attempts_within_window,
        attempts_used = excluded.attempts_used,
        cooldown_until = excluded.cooldown_until
    `);
  }

  public async findByTriggerSource(
    triggerSource: ConsolidationTriggerSource
  ): Promise<ConsolidationTriggerBudget | null> {
    const row = this.findStatement.get(triggerSource) as
      | {
          readonly trigger_id: string;
          readonly trigger_source: string;
          readonly governance_subject: string | null;
          readonly source_object_ref: string | null;
          readonly max_attempts_within_window: number;
          readonly attempts_used: number;
          readonly cooldown_until: string;
        }
      | undefined;
    if (row === undefined) {
      return null;
    }
    return ConsolidationTriggerBudgetSchema.parse({
      trigger_id: row.trigger_id,
      trigger_source: row.trigger_source,
      ...(row.governance_subject === null ? {} : { governance_subject: row.governance_subject }),
      ...(row.source_object_ref === null ? {} : { source_object_ref: row.source_object_ref }),
      max_attempts_within_window: row.max_attempts_within_window,
      attempts_used: row.attempts_used,
      cooldown_until: row.cooldown_until
    });
  }

  public async upsert(budget: ConsolidationTriggerBudget): Promise<void> {
    this.upsertStatement.run(
      budget.trigger_id,
      budget.trigger_source,
      budget.governance_subject ?? null,
      budget.source_object_ref ?? null,
      budget.max_attempts_within_window,
      budget.attempts_used,
      budget.cooldown_until
    );
  }
}

export interface SqlitePreparedStatement {
  get(...params: readonly unknown[]): unknown;
  run(...params: readonly unknown[]): unknown;
}
