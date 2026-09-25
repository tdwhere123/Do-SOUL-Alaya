import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import { pairKey } from "./path-routing.js";

export class ObservationSubjects implements ReadonlySet<string> {
  public constructor(public snapshot: PersistentStringMap<true>) {}
  public get size(): number { return this.snapshot.size; }
  public get [Symbol.toStringTag](): string { return "ObservationSubjects"; }
  public has(id: string): boolean { return this.snapshot.has(id); }
  public add(id: string): void { if (!this.snapshot.has(id)) this.snapshot = this.snapshot.with(id, true); }
  public keys(): SetIterator<string> { return this.snapshot.keys(); }
  public values(): SetIterator<string> { return this.snapshot.keys(); }
  public [Symbol.iterator](): SetIterator<string> { return this.snapshot.keys(); }
  public *entries(): SetIterator<[string, string]> { for (const id of this.snapshot.keys()) yield [id, id]; }
  public forEach(callback: (value: string, value2: string, set: ReadonlySet<string>) => void): void {
    for (const id of this.snapshot.keys()) callback(id, id, this);
  }
}

export class ObservationPairs implements ReadonlyMap<string, string | null> {
  public constructor(public snapshot: PersistentStringMap<string | null>, public completed: number, public revision: number,
    public demanded: PersistentStringMap<true> = new PersistentStringMap(), public bytes = 0) {}
  public get size(): number { return this.snapshot.size; }
  public get [Symbol.toStringTag](): string { return "ObservationPairs"; }
  public has(id: string): boolean { return this.snapshot.has(id); }
  public get(id: string): string | null | undefined { return this.snapshot.get(id); }
  public set(id: string, value: string | null): void {
    if (this.snapshot.has(id) && this.snapshot.get(id) === value) return;
    const previous = this.snapshot.get(id);
    this.bytes += this.snapshot.has(id) ? Buffer.byteLength(value ?? "", "utf8") - Buffer.byteLength(previous ?? "", "utf8")
      : 96 + Buffer.byteLength(id, "utf8") + Buffer.byteLength(value ?? "", "utf8");
    if (id.endsWith(":done") && !this.snapshot.has(id)) this.completed += 1;
    this.snapshot = this.snapshot.with(id, value); this.revision += 1;
  }
  public hasOpenDemand(): boolean { return this.completed < this.demanded.size; }
  public status(subject: string, predicate: string): "unobserved" | "open" | "complete" {
    const key = pairKey(subject, predicate);
    if (!this.demanded.has(key)) return "unobserved";
    return this.snapshot.has(`${key}:done`) ? "complete" : "open";
  }
  public nextDemand(start: number, allowance: number): Readonly<{
    key?: string; next: number; work: number;
  }> {
    const total = this.demanded.size;
    let work = 0;
    while (work < Math.min(total, allowance)) {
      const index = (start + work) % total;
      const key = this.demanded.entryAt(index)?.[0];
      work += 1;
      if (key !== undefined && !this.snapshot.has(`${key}:done`)) return { key, next: index + 1, work };
    }
    return { next: total === 0 ? 0 : (start + work) % total, work };
  }
  public keys(): MapIterator<string> { return this.snapshot.keys(); }
  public values(): MapIterator<string | null> { return this.snapshot.values(); }
  public entries(): MapIterator<[string, string | null]> { return this.snapshot.entries(); }
  public [Symbol.iterator](): MapIterator<[string, string | null]> { return this.snapshot.entries(); }
  public forEach(callback: (value: string | null, key: string, map: ReadonlyMap<string, string | null>) => void): void {
    for (const [id, value] of this.snapshot) callback(value, id, this);
  }
}

/** Retained fact demands keep closure O(1) and scan only budgeted index entries. */
export class SourceFactDemands {
  public constructor(public snapshot: PersistentStringMap<"pending" | "done">,
    public pending: number, public offset: number, public bytes: number) {}
  public hasPending(): boolean { return this.pending > 0; }
  public complete(id: string): void {
    if (this.snapshot.get(id) !== "pending") return;
    this.snapshot = this.snapshot.with(id, "done");
    this.pending -= 1;
  }
  public nextPending(allowance: number): Readonly<{ key?: string; index?: number; next: number; work: number }> {
    const total = this.snapshot.size;
    if (this.pending === 0 || total === 0) return { next: this.offset, work: 0 };
    let work = 0;
    while (work < Math.min(total, allowance)) {
      const index = (this.offset + work) % total;
      const entry = this.snapshot.entryAt(index);
      work += 1;
      if (entry?.[1] === "pending") return { key: entry[0], index, next: (index + 1) % total, work };
    }
    return { next: (this.offset + work) % total, work };
  }
}
