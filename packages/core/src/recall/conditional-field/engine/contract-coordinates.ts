import { PersistentStringMap } from "@do-soul/alaya-graph-algorithms";
import type { SeedActivation, Transition } from "@do-soul/alaya-protocol";
import { assertContractGrade, isHardIdentityContractId, normalizeFieldPartitionContract } from "../cap-contract.js";
import { RetainedSequence } from "./retained-sequence.js";

export type ContractRow = Readonly<{ seed: SeedActivation; transition?: never } | { transition: Transition; seed?: never }>;
export type CoordinateRow = ContractRow & Readonly<{ coordinate: string }>;
type Pending = Readonly<{ kind: "hard"; row: ContractRow; offset: number }
  | { kind: "coordinate"; coordinate: string; offset: number }>;

/** A retained, bounded join of Hard rows with admitted numeric coordinates.
 * Original rows stay intact: lifting changes the equation's coordinate, never its evidence identity.
 * Exhaust each fan-out before admitting another row, so there is only one pending cursor. */
export type ContractCoordinates = Readonly<{
  coordinates: PersistentStringMap<true>;
  hard: RetainedSequence<ContractRow>;
  pending?: Pending;
}>;

export function emptyContractCoordinates(): ContractCoordinates {
  return { coordinates: new PersistentStringMap(), hard: RetainedSequence.empty() };
}

export function coordinateOf(row: ContractRow): string {
  return normalizeFieldPartitionContract((row.seed ?? row.transition).cap_contract_id);
}

export function admitContractRow(state: ContractCoordinates, row: ContractRow): ContractCoordinates {
  const value = row.seed ?? row.transition;
  if (row.transition?.applicable === false) return state;
  assertContractGrade(value.cap_contract_id, row.seed?.milligrades ?? row.transition!.strength_milligrades);
  const coordinate = coordinateOf(row);
  if (isHardIdentityContractId(coordinate)) {
    return { ...state, hard: state.hard.append(row), pending: state.coordinates.size === 0 ? undefined
      : { kind: "hard", row, offset: 0 } };
  }
  if (state.coordinates.has(coordinate)) return state;
  return { ...state, coordinates: state.coordinates.with(coordinate, true), pending: state.hard.length === 0 ? undefined
    : { kind: "coordinate", coordinate, offset: 0 } };
}

export function nextCoordinateRow(state: ContractCoordinates): CoordinateRow | undefined {
  const pending = state.pending;
  if (pending === undefined) return undefined;
  if (pending.kind === "hard") return { ...pending.row, coordinate: state.coordinates.entryAt(pending.offset)![0] };
  return { ...state.hard.at(pending.offset)!, coordinate: pending.coordinate };
}

export function advanceContractCoordinates(state: ContractCoordinates): ContractCoordinates {
  const pending = state.pending!;
  const offset = pending.offset + 1;
  return { ...state, pending: offset === (pending.kind === "hard" ? state.coordinates.size : state.hard.length)
    ? undefined : { ...pending, offset } };
}
