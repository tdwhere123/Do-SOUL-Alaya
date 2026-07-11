export function throwLifecycleErrors(
  message: string,
  errors: readonly (unknown | undefined)[]
): void {
  const present = errors.filter((error) => error !== undefined);
  if (present.length === 0) return;
  if (present.length === 1) throw present[0];
  throw new AggregateError(present, message, { cause: present[0] });
}
