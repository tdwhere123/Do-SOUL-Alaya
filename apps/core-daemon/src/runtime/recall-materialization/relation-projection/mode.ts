export type RelationProjectionAdmissionMode =
  | "immediate"
  | "explicit_checkpoint";

export const DEFAULT_RELATION_PROJECTION_ADMISSION_MODE = "immediate" as const;
