export class GardenTaskClaimCasMiss extends Error {
  constructor() {
    super("Garden task already claimed by another worker.");
    this.name = "GardenTaskClaimCasMiss";
  }
}

export class GardenTaskPendingFailureCasMiss extends Error {
  constructor() {
    super("Garden task is no longer pending.");
    this.name = "GardenTaskPendingFailureCasMiss";
  }
}

export class GardenTaskAlreadyCompleted extends Error {
  constructor() {
    super("Garden task completion was already committed.");
    this.name = "GardenTaskAlreadyCompleted";
  }
}

export { isUniqueConstraintError } from "@do-soul/alaya-protocol";
