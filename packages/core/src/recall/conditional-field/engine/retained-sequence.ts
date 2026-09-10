import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";

export interface RetainedRows<T> extends Iterable<T> {
  readonly length: number;
  at(index: number): T | undefined;
  slice(start?: number, end?: number): RetainedRows<T>;
  map<U>(callback: (value: T, index: number) => U): U[];
  flatMap<U>(callback: (value: T, index: number) => U | readonly U[]): U[];
  filter<S extends T>(callback: (value: T, index: number) => value is S): S[];
  filter(callback: (value: T, index: number) => unknown): T[];
  find(callback: (value: T, index: number) => unknown): T | undefined;
  findIndex(callback: (value: T, index: number) => unknown): number;
  some(callback: (value: T, index: number) => unknown): boolean;
  every(callback: (value: T, index: number) => unknown): boolean;
  forEach(callback: (value: T, index: number) => void): void;
}

/** Ordered immutable rows share untouched index paths across observation pages. */
export class RetainedSequence<T> implements RetainedRows<T> {
  private constructor(private readonly rows: PersistentStringMap<T>, public readonly length: number, private readonly start = 0) {}
  public static empty<T>(): RetainedSequence<T> { return new RetainedSequence(new PersistentStringMap<T>(), 0); }
  public static from<T>(rows: RetainedRows<T>): RetainedSequence<T> {
    if (rows instanceof RetainedSequence) return rows;
    let sequence = RetainedSequence.empty<T>();
    for (const row of rows) sequence = sequence.append(row);
    return sequence;
  }
  public at(index: number): T | undefined {
    const position = index < 0 ? this.length + index : index;
    return position < 0 || position >= this.length ? undefined : this.rows.get(ordinal(this.start + position));
  }
  public append(row: T): RetainedSequence<T> {
    return new RetainedSequence(this.rows.with(ordinal(this.start + this.length), row), this.length + 1, this.start);
  }
  public replace(index: number, row: T): RetainedSequence<T> {
    if (index < 0 || index >= this.length) throw new RangeError("retained row index is outside its version");
    return this.at(index) === row ? this : new RetainedSequence(this.rows.with(ordinal(this.start + index), row), this.length, this.start);
  }
  public concat(rows: Iterable<T>): RetainedSequence<T> {
    let sequence: RetainedSequence<T> = this;
    for (const row of rows) sequence = sequence.append(row);
    return sequence;
  }
  public slice(start = 0, end = this.length): RetainedSequence<T> {
    const left = Math.max(0, Math.min(this.length, start < 0 ? this.length + start : start));
    const right = Math.max(left, Math.min(this.length, end < 0 ? this.length + end : end));
    return left === 0 && right === this.length ? this : new RetainedSequence(this.rows, right - left, this.start + left);
  }
  public *[Symbol.iterator](): IterableIterator<T> { for (let index = 0; index < this.length; index += 1) yield this.at(index)!; }
  public map<U>(callback: (value: T, index: number) => U): U[] {
    const output: U[] = []; let index = 0;
    for (const row of this) output.push(callback(row, index++));
    return output;
  }
  public flatMap<U>(callback: (value: T, index: number) => U | readonly U[]): U[] {
    return this.map(callback).flat() as U[];
  }
  public filter<S extends T>(callback: (value: T, index: number) => value is S): S[];
  public filter(callback: (value: T, index: number) => unknown): T[];
  public filter(callback: (value: T, index: number) => unknown): T[] {
    const output: T[] = []; let index = 0;
    for (const row of this) if (callback(row, index++)) output.push(row);
    return output;
  }
  public find(callback: (value: T, index: number) => unknown): T | undefined { let index = 0; for (const row of this) if (callback(row, index++)) return row; return undefined; }
  public findIndex(callback: (value: T, index: number) => unknown): number { let index = 0; for (const row of this) { if (callback(row, index)) return index; index += 1; } return -1; }
  public some(callback: (value: T, index: number) => unknown): boolean { return this.findIndex(callback) >= 0; }
  public every(callback: (value: T, index: number) => unknown): boolean { return this.findIndex((row, index) => !callback(row, index)) < 0; }
  public forEach(callback: (value: T, index: number) => void): void { let index = 0; for (const row of this) callback(row, index++); }
}

export class RetainedRowDraft<T> {
  public constructor(public rows: RetainedSequence<T>) {}
  public get length(): number { return this.rows.length; }
  public at(index: number): T | undefined { return this.rows.at(index); }
  public push(row: T): void { this.rows = this.rows.append(row); }
  public replace(index: number, row: T): void { this.rows = this.rows.replace(index, row); }
}

function ordinal(index: number): string { return index.toString().padStart(16, "0"); }
