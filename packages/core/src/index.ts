export { CoreError, type CoreErrorCode } from "./errors.js";
export {
  DEFAULT_ACTOR,
  SYSTEM_ACTOR,
  SYSTEM_WORKSPACE_ID,
  resolveSystemWorkspaceId
} from "./shared/actors.js";
export { deepFreeze } from "./shared/deep-freeze.js";
export {
  getNextRevision,
  isUniqueConstraintError,
  type EventRevisionLookupPort
} from "./shared/event-utils.js";
export {
  parseExtensionSkillPackage,
  parseExtensionToolProvider
} from "./shared/extension-descriptor-parsers.js";
export {
  loadOrDefaultWithWorkspaceGuard,
  type LoadOrDefaultWithWorkspaceGuardInput,
  type LoadOrDefaultWithWorkspaceGuardResult
} from "./shared/load-or-default-with-workspace-guard.js";
export { normalizeUnit } from "./shared/normalize-unit.js";
export { parseRecallPolicy } from "./shared/recall-policy.js";
export { SURFACE_URI_PATTERN, parseSurfaceUri } from "./shared/surface-uri.js";
export {
  addDuration,
  ensureIsoDatetime,
  readClockSnapshot,
  readNow,
  systemNow,
  type NowProvider
} from "./shared/time.js";
export { validateActivationCandidates } from "./shared/validated-activation-candidates.js";
export {
  normalizeOptionalNonEmptyString,
  parseNonEmptyString,
  parseObjectId
} from "./shared/validators.js";
