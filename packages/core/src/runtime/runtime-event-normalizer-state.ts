const DEFAULT_NORMALIZER_SESSION_CAP = 1024;

// Bounds per-session dedup state so orphan sessions (never cleared) cannot leak.
// Insertion-order cap: the oldest tracked sessionId is dropped when the cap is
// exceeded. clear/release semantics are unchanged.
export class RuntimeEventNormalizerState {
  private readonly messageDeltaDedup = new Map<string, Set<number>>();
  private readonly sessionFinishedDedup = new Map<string, "pending" | "appended">();
  private readonly trackedSessions = new Set<string>();
  private readonly maxSessions: number;

  public constructor(maxSessions: number = DEFAULT_NORMALIZER_SESSION_CAP) {
    this.maxSessions = maxSessions > 0 ? maxSessions : DEFAULT_NORMALIZER_SESSION_CAP;
  }

  public get trackedKeyCount(): number {
    return this.trackedSessions.size;
  }

  public reserveMessageDelta(sessionId: string, sequence: number): boolean {
    const sequences = this.messageDeltaDedup.get(sessionId) ?? new Set<number>();

    if (sequences.has(sequence)) {
      return false;
    }

    sequences.add(sequence);
    this.messageDeltaDedup.set(sessionId, sequences);
    this.touchSession(sessionId);
    return true;
  }

  public releaseMessageDelta(sessionId: string, sequence: number): void {
    const sequences = this.messageDeltaDedup.get(sessionId);

    if (sequences === undefined) {
      return;
    }

    sequences.delete(sequence);

    if (sequences.size === 0) {
      this.messageDeltaDedup.delete(sessionId);
      this.dropSessionIfIdle(sessionId);
    }
  }

  public reserveSessionFinished(sessionId: string): boolean {
    if (this.sessionFinishedDedup.get(sessionId) !== undefined) {
      return false;
    }

    this.sessionFinishedDedup.set(sessionId, "pending");
    this.touchSession(sessionId);
    return true;
  }

  public markSessionFinishedAppended(sessionId: string): void {
    this.sessionFinishedDedup.set(sessionId, "appended");
  }

  public clearSessionState(sessionId: string): void {
    this.messageDeltaDedup.delete(sessionId);
    this.sessionFinishedDedup.delete(sessionId);
    this.trackedSessions.delete(sessionId);
  }

  private touchSession(sessionId: string): void {
    this.trackedSessions.delete(sessionId);
    this.trackedSessions.add(sessionId);
    this.evictOldestWhileOverCap();
  }

  private dropSessionIfIdle(sessionId: string): void {
    if (!this.sessionFinishedDedup.has(sessionId)) {
      this.trackedSessions.delete(sessionId);
    }
  }

  private evictOldestWhileOverCap(): void {
    while (this.trackedSessions.size > this.maxSessions) {
      const oldest = this.trackedSessions.values().next().value;
      if (oldest === undefined) {
        return;
      }
      this.clearSessionState(oldest);
    }
  }
}
