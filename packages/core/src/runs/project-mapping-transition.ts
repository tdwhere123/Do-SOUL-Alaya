import type { ProjectMappingState as ProjectMappingStateType } from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";

export function resolveProjectMappingFromState(
  currentState: ProjectMappingStateType,
  options: {
    readonly targetState: ProjectMappingStateType;
    readonly allowedFromStates?: readonly ProjectMappingStateType[];
    readonly fallbackFromState?: ProjectMappingStateType;
  }
): ProjectMappingStateType {
  if (options.allowedFromStates === undefined) {
    return currentState;
  }

  if (options.allowedFromStates.includes(currentState)) {
    return currentState;
  }

  if (currentState === options.targetState && options.fallbackFromState !== undefined) {
    return options.fallbackFromState;
  }

  throw new CoreError(
    "CONFLICT",
    `Project mapping transition ${currentState} -> ${options.targetState} is not allowed.`
  );
}
