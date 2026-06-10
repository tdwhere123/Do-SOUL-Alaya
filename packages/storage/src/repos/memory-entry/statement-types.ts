export interface SqliteRunResult {
  readonly changes: number;
}

export interface SqliteRunStatement {
  run(...params: unknown[]): SqliteRunResult;
}

export interface SqliteGetStatement {
  get(...params: unknown[]): unknown;
}

export interface SqliteAllStatement {
  all(...params: unknown[]): unknown[];
}
