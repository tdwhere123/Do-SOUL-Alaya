import type {
  AuditorBootstrappingPort,
  AuditorEventLogPort,
  AuditorEvidenceCheckPort,
  AuditorGreenMaintenancePort,
  AuditorOrphanDetectionPort,
  AuditorPointerHealPort,
  AuditorPointerHealthPort,
  AuditorSchedulerPort,
  HealthIssueCauseKindValue,
  HealthIssueGroup,
  HealthJournalRecordPort
} from "@do-soul/alaya-protocol";

export const AUDITOR_CONSTANTS = {
  COLD_START_MEMORY_THRESHOLD: 10,
  COLD_START_CLAIM_THRESHOLD: 5,
  CRYSTALLIZATION_THRESHOLD: 3,
  EXPIRY_LOOKAHEAD_MS: 7 * 86_400_000,
  ORPHAN_RADAR_TTL_MS: 48 * 3_600_000,
  RECOVERY_WINDOW_MS: 3_600_000,
  BATCH_SIZE: 20,
  // invariant: must mirror the storage-side ACTIVE_VERIFICATION_GRACE_MS.
  ACTIVE_VERIFICATION_GRACE_MS: 7 * 86_400_000
} as const;

export interface AuditorHealthIssueGroupPort {
  findExistingGroup(input: {
    readonly workspaceId: string;
    readonly targetObjectId: string;
    readonly causeKind: HealthIssueCauseKindValue;
  }): Promise<Readonly<HealthIssueGroup> | null> | Readonly<HealthIssueGroup> | null;
  upsertHealthIssueGroup(group: HealthIssueGroup): Promise<void> | void;
  generateGroupId?: () => string;
}

export interface AuditorDependencies {
  readonly evidenceCheckPort: AuditorEvidenceCheckPort;
  readonly pointerHealthPort: AuditorPointerHealthPort;
  readonly pointerHealPort?: AuditorPointerHealPort;
  readonly orphanDetectionPort?: AuditorOrphanDetectionPort;
  readonly greenMaintenancePort: AuditorGreenMaintenancePort;
  readonly bootstrappingPort: AuditorBootstrappingPort;
  readonly scheduler: AuditorSchedulerPort;
  readonly eventLogRepo?: AuditorEventLogPort;
  readonly healthJournal?: HealthJournalRecordPort;
  readonly healthIssueGroupPort?: AuditorHealthIssueGroupPort;
  readonly now?: () => string;
}
