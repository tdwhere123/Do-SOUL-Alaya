export const ISOLATION_SIGNAL_FAILURE_EXIT: 86;

export class ProviderFreeIsolationError extends Error {
  readonly code: "PROVIDER_FREE_ISOLATION_FAILED";
  readonly evidence: string;
  readonly reasons: readonly string[];
  constructor(evidence: string, reasons: readonly string[]);
}

export class ProviderFreeIsolation {
  readonly binding: { root: string; member: string; identity: string };
  ready(): void;
  environment(env: NodeJS.ProcessEnv | undefined, member?: string): NodeJS.ProcessEnv;
  reserve(kind: string): string;
  violation(kind: string): void;
  cancelled(member: string): void;
  exited(member: string, code: number | null, signal?: string | null): void;
  spawnFailed(member: string): void;
  assertSafe(requireSettled?: boolean): void;
}
