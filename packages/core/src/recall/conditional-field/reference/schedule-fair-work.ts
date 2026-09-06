export type FairWorkRegion = Readonly<{
  readonly id: string;
  readonly priority: number;
  readonly finite: boolean;
  readonly work: number;
}>;

export type FairWorkSchedule = Readonly<{
  readonly served: readonly string[];
  readonly remainingReserve: number;
  readonly starvedFinite: boolean;
}>;

export type FairWorkInput = Readonly<{
  readonly regions: readonly FairWorkRegion[];
  readonly explorationBudget: number;
  readonly finalizationReserve: number;
  readonly totalWork: number;
}>;

export function scheduleFairWork(input: FairWorkInput): FairWorkSchedule {
  // Finite lower-priority regions run before unbounded refinement; reserve is not exploration.
  const exploration = Math.min(
    input.explorationBudget,
    Math.max(0, input.totalWork - input.finalizationReserve)
  );
  const served: string[] = [];
  let remaining = exploration;
  const finite = input.regions.filter((region) => region.finite)
    .sort((left, right) => left.priority - right.priority);
  const infinite = input.regions.filter((region) => !region.finite)
    .sort((left, right) => right.priority - left.priority);
  for (const region of finite) {
    if (remaining < region.work) continue;
    remaining -= region.work;
    served.push(region.id);
  }
  for (const region of infinite) {
    if (remaining <= 0) break;
    remaining -= Math.min(remaining, region.work);
    served.push(region.id);
  }
  return {
    served,
    remainingReserve: input.finalizationReserve,
    starvedFinite: finite.some((region) => !served.includes(region.id))
  };
}
