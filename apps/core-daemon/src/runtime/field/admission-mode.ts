export type FieldProjectionAdmissionMode =
  | "immediate"
  | "explicit_checkpoint";

export const DEFAULT_FIELD_PROJECTION_ADMISSION_MODE = "immediate" as const;
