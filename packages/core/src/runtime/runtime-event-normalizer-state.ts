export class RuntimeEventNormalizerState {
  private readonly messageDeltaDedup = new Map<string, Set<number>>();
  private readonly sessionFinishedDedup = new Map<string, "pending" | "appended">();

  public reserveMessageDelta(sessionId: string, sequence: number): boolean {
    const sequences = this.messageDeltaDedup.get(sessionId) ?? new Set<number>();

    if (sequences.has(sequence)) {
      return false;
    }

    sequences.add(sequence);
    this.messageDeltaDedup.set(sessionId, sequences);
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
    }
  }

  public reserveSessionFinished(sessionId: string): boolean {
    if (this.sessionFinishedDedup.get(sessionId) !== undefined) {
      return false;
    }

    this.sessionFinishedDedup.set(sessionId, "pending");
    return true;
  }

  public markSessionFinishedAppended(sessionId: string): void {
    this.sessionFinishedDedup.set(sessionId, "appended");
  }

  public clearSessionState(sessionId: string): void {
    this.messageDeltaDedup.delete(sessionId);
    this.sessionFinishedDedup.delete(sessionId);
  }
}
