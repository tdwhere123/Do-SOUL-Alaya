/** Gate failures must name one source record; callers share this wrapper. */
export function withSelectionBoundaryRecordIdentity<T>(
  prefix: string,
  record: Readonly<{
    readonly question_id: string;
    readonly invocation_index: number;
  }>,
  recordIndex: number,
  run: () => T
): T {
  try {
    return run();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${prefix} ` +
      `(question_id=${record.question_id}, ` +
      `invocation_index=${record.invocation_index}, ` +
      `record_index=${recordIndex}): ${message}`,
      { cause }
    );
  }
}
