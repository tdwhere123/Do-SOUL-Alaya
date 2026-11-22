// Both admission receipts and indexed recall rows use these evidence identities.
export function erasedFormationEvidenceSql(workspaceId: string, evidenceId: string, eventType: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM source_erase_evidence_barriers erased
      WHERE erased.workspace_id = ${workspaceId} AND erased.evidence_id = ${evidenceId}
    ) OR (${eventType} = 'soul.field.source_record.admitted' AND EXISTS (
      SELECT 1 FROM projection_erase_barriers erased
      WHERE erased.workspace_id = ${workspaceId} AND erased.subject_kind = 'source_record'
        AND erased.subject_id = ${evidenceId}
    ))
  )`;
}

export function erasedAssertionSql(workspaceId: string, assertionId: string): string {
  return `EXISTS (
    SELECT 1 FROM relation_assertion_evidence receipt
    WHERE receipt.assertion_id = ${assertionId}
      AND ${erasedFormationEvidenceSql(workspaceId, "receipt.evidence_id", "receipt.source_event_type")}
  )`;
}
