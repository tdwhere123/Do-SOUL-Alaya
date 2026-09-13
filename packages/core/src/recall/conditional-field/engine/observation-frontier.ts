import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";

export class ObservationSubjects implements ReadonlySet<string> {
  private mergedSnapshot?: PersistentStringMap<true>;
  private mergedDiscoveries?: readonly Readonly<{ subject_id: string }>[];
  private mergedView?: ObservationSubjects;

  public constructor(public snapshot: PersistentStringMap<true>) {}
  public get size(): number { return this.snapshot.size; }
  public get [Symbol.toStringTag](): string { return "ObservationSubjects"; }
  public has(id: string): boolean { return this.snapshot.has(id); }
  public add(id: string): void { if (!this.snapshot.has(id)) this.snapshot = this.snapshot.with(id, true); }
  public at(index: number): string | undefined { return this.snapshot.entryAt(index)?.[0]; }
  public includingDiscoveries(discoveries: readonly Readonly<{ subject_id: string }>[]): ObservationSubjects {
    if (discoveries.length === 0) return this;
    if (this.mergedView !== undefined && this.mergedDiscoveries === discoveries && this.mergedSnapshot === this.snapshot) {
      return this.mergedView;
    }
    let next = this.snapshot;
    for (const row of discoveries) {
      if (!next.has(row.subject_id)) next = next.with(row.subject_id, true);
    }
    const view = next === this.snapshot ? this : new ObservationSubjects(next);
    this.mergedSnapshot = this.snapshot;
    this.mergedDiscoveries = discoveries;
    this.mergedView = view;
    return view;
  }
  public keys(): SetIterator<string> { return this.snapshot.keys(); }
  public values(): SetIterator<string> { return this.snapshot.keys(); }
  public [Symbol.iterator](): SetIterator<string> { return this.snapshot.keys(); }
  public *entries(): SetIterator<[string, string]> { for (const id of this.snapshot.keys()) yield [id, id]; }
  public forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void): void {
    for (const id of this.snapshot.keys()) callback(id, id, this);
  }
}

export class ObservationPairs implements ReadonlyMap<string, string | null> {
  public constructor(public snapshot: PersistentStringMap<string | null>, public completed: number, public revision: number) {}
  public get size(): number { return this.snapshot.size; }
  public get [Symbol.toStringTag](): string { return "ObservationPairs"; }
  public has(id: string): boolean { return this.snapshot.has(id); }
  public get(id: string): string | null | undefined { return this.snapshot.get(id); }
  public set(id: string, value: string | null): void {
    if (this.snapshot.has(id) && this.snapshot.get(id) === value) return;
    if (id.endsWith(":done") && !this.snapshot.has(id)) this.completed += 1;
    this.snapshot = this.snapshot.with(id, value); this.revision += 1;
  }
  public keys(): MapIterator<string> { return this.snapshot.keys(); }
  public values(): MapIterator<string | null> { return this.snapshot.values(); }
  public entries(): MapIterator<[string, string | null]> { return this.snapshot.entries(); }
  public [Symbol.iterator](): MapIterator<[string, string | null]> { return this.snapshot.entries(); }
  public forEach(callback: (value: string | null, key: string, map: ReadonlyMap<string, string | null>) => void): void {
    for (const [id, value] of this.snapshot) callback(value, id, this);
  }
}
