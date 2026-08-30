import { ShadowContractError } from "../../../prefix-capture/envelope.js";
import { createTypedWitness, rejectPayload } from "../shared/create.js";
import { joinWitness, meetWitness, refineWitness } from "../shared/kernel.js";
import { compareWitness, informationLeq } from "../shared/kernel-order.js";
import type { PayloadOps } from "../shared/kernel-ops.js";
import type {
  TypedWitness,
  WitnessCreateInput,
  WitnessEpistemic,
  WitnessInformationOrder
} from "../shared/types.js";

export type ValidTimeForm =
  | Readonly<{ readonly kind: "bounded"; readonly from: number; readonly to: number }>
  | Readonly<{ readonly kind: "open"; readonly from: number }>
  | Readonly<{ readonly kind: "timeless" }>
  | Readonly<{ readonly kind: "unknown" }>;

export type TransactionTimeForm =
  | Readonly<{ readonly kind: "bounded"; readonly from: number; readonly to: number }>
  | Readonly<{ readonly kind: "open"; readonly from: number }>
  | Readonly<{ readonly kind: "unknown" }>;

export type BitemporalPayload = Readonly<{
  readonly valid: ValidTimeForm;
  readonly transaction: TransactionTimeForm;
}>;

export type BitemporalWitness = TypedWitness<"temporal_bitemporal", BitemporalPayload>;
export type BitemporalInput = WitnessCreateInput<BitemporalPayload>;

const TEMPORAL_OPS: PayloadOps<BitemporalPayload> = Object.freeze({
  leq: bitemporalLeq,
  equal: bitemporalEqual,
  meet: bitemporalMeet,
  join: bitemporalJoin,
  contradictory: bitemporalContradictory
});

export function createBitemporalWitness(input: BitemporalInput): BitemporalWitness {
  return createTypedWitness("temporal_bitemporal", input, ["candidate_id"], bitemporalPayload);
}

export function compareBitemporal(
  left: BitemporalWitness,
  right: BitemporalWitness
): WitnessInformationOrder {
  return compareWitness(TEMPORAL_OPS, left, right);
}

export function bitemporalInformationLeq(
  wide: BitemporalWitness,
  narrow: BitemporalWitness
): boolean {
  return informationLeq(TEMPORAL_OPS, wide, narrow);
}

export function refineBitemporal(from: BitemporalWitness, to: BitemporalWitness): BitemporalWitness {
  return refineWitness(TEMPORAL_OPS, from, to);
}

export function meetBitemporal(left: BitemporalWitness, right: BitemporalWitness): BitemporalWitness {
  return meetWitness(TEMPORAL_OPS, left, right);
}

export function joinBitemporal(left: BitemporalWitness, right: BitemporalWitness): BitemporalWitness {
  return joinWitness(TEMPORAL_OPS, left, right);
}

function bitemporalPayload(
  epistemic: WitnessEpistemic,
  payload: BitemporalPayload | null | undefined
): BitemporalPayload | null {
  if (epistemic.kind !== "exact") return rejectPayload(payload, epistemic.kind);
  if (payload === null || payload === undefined) {
    throw new ShadowContractError("exact bitemporal witness requires time forms");
  }
  return Object.freeze({
    valid: parseValidTime(payload.valid),
    transaction: parseTransactionTime(payload.transaction)
  });
}

function parseValidTime(value: ValidTimeForm): ValidTimeForm {
  if (value.kind === "timeless" || value.kind === "unknown") {
    return Object.freeze({ kind: value.kind });
  }
  return parseIntervalForm(value);
}

function parseTransactionTime(value: TransactionTimeForm): TransactionTimeForm {
  if (value.kind === "unknown") return Object.freeze({ kind: "unknown" as const });
  if (value.kind === "bounded" || value.kind === "open") return parseIntervalForm(value);
  throw new ShadowContractError("transaction time cannot be timeless");
}

function parseIntervalForm(
  value: Extract<ValidTimeForm, { kind: "bounded" | "open" }>
): Extract<ValidTimeForm, { kind: "bounded" | "open" }> {
  const from = requireFiniteTime(value.from, "from");
  if (value.kind === "open") return Object.freeze({ kind: "open", from });
  const to = requireFiniteTime(value.to, "to");
  if (from >= to) throw new ShadowContractError("inverted bounds");
  return Object.freeze({ kind: "bounded", from, to });
}

function requireFiniteTime(value: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ShadowContractError(`${label} must be finite`);
  }
  return value;
}

function bitemporalLeq(wide: BitemporalPayload, narrow: BitemporalPayload): boolean {
  return validLeq(wide.valid, narrow.valid) &&
    transactionLeq(wide.transaction, narrow.transaction);
}

function bitemporalEqual(left: BitemporalPayload, right: BitemporalPayload): boolean {
  return timeEqual(left.valid, right.valid) && timeEqual(left.transaction, right.transaction);
}

function bitemporalMeet(
  left: BitemporalPayload,
  right: BitemporalPayload
): BitemporalPayload | "conflict" {
  const valid = meetValid(left.valid, right.valid);
  const transaction = meetTransaction(left.transaction, right.transaction);
  if (valid === "conflict" || transaction === "conflict") return "conflict";
  return Object.freeze({ valid, transaction });
}

function bitemporalJoin(left: BitemporalPayload, right: BitemporalPayload): BitemporalPayload {
  return Object.freeze({
    valid: joinValid(left.valid, right.valid),
    transaction: joinTransaction(left.transaction, right.transaction)
  });
}

function bitemporalContradictory(left: BitemporalPayload, right: BitemporalPayload): boolean {
  return bitemporalMeet(left, right) === "conflict";
}

function validLeq(wide: ValidTimeForm, narrow: ValidTimeForm): boolean {
  if (wide.kind === "unknown") return true;
  if (narrow.kind === "unknown") return false;
  const wideInterval = intervalOrTimeless(wide);
  const narrowInterval = intervalOrTimeless(narrow);
  if (wideInterval === "timeless" || narrowInterval === "timeless") {
    if (wideInterval === "timeless" && narrowInterval === "timeless") return true;
    throw new ShadowContractError("illegal temporal-domain comparison");
  }
  return intervalFormLeq(wideInterval, narrowInterval);
}

function transactionLeq(wide: TransactionTimeForm, narrow: TransactionTimeForm): boolean {
  if (wide.kind === "unknown") return true;
  if (narrow.kind === "unknown") return false;
  return intervalFormLeq(wide, narrow);
}

function intervalFormLeq(
  wide: Extract<ValidTimeForm, { kind: "bounded" | "open" }>,
  narrow: Extract<ValidTimeForm, { kind: "bounded" | "open" }>
): boolean {
  if (narrow.from < wide.from) return false;
  if (wide.kind === "open") return true;
  if (narrow.kind === "open") return false;
  return narrow.to <= wide.to;
}

function meetValid(left: ValidTimeForm, right: ValidTimeForm): ValidTimeForm | "conflict" {
  if (left.kind === "unknown") return right;
  if (right.kind === "unknown") return left;
  const leftInterval = intervalOrTimeless(left);
  const rightInterval = intervalOrTimeless(right);
  if (leftInterval === "timeless" && rightInterval === "timeless") return left;
  if (leftInterval === "timeless" || rightInterval === "timeless") {
    throw new ShadowContractError("illegal temporal-domain comparison");
  }
  return meetIntervalForm(leftInterval, rightInterval);
}

function meetTransaction(
  left: TransactionTimeForm,
  right: TransactionTimeForm
): TransactionTimeForm | "conflict" {
  if (left.kind === "unknown") return right;
  if (right.kind === "unknown") return left;
  return meetIntervalForm(left, right);
}

function meetIntervalForm(
  left: Extract<ValidTimeForm, { kind: "bounded" | "open" }>,
  right: Extract<ValidTimeForm, { kind: "bounded" | "open" }>
): Extract<ValidTimeForm, { kind: "bounded" | "open" }> | "conflict" {
  const from = Math.max(left.from, right.from);
  if (left.kind === "open" && right.kind === "open") {
    return Object.freeze({ kind: "open", from });
  }
  const to = left.kind === "bounded" ? left.to : right.kind === "bounded" ? right.to : from;
  const boundedTo = left.kind === "bounded" && right.kind === "bounded"
    ? Math.min(left.to, right.to)
    : to;
  if (from >= boundedTo) return "conflict";
  return Object.freeze({ kind: "bounded", from, to: boundedTo });
}

function joinValid(left: ValidTimeForm, right: ValidTimeForm): ValidTimeForm {
  if (left.kind === "unknown" || right.kind === "unknown") {
    return Object.freeze({ kind: "unknown" });
  }
  const leftInterval = intervalOrTimeless(left);
  const rightInterval = intervalOrTimeless(right);
  if (leftInterval === "timeless" && rightInterval === "timeless") return left;
  if (leftInterval === "timeless" || rightInterval === "timeless") {
    throw new ShadowContractError("illegal temporal-domain comparison");
  }
  return joinIntervalForm(leftInterval, rightInterval);
}

function joinTransaction(left: TransactionTimeForm, right: TransactionTimeForm): TransactionTimeForm {
  if (left.kind === "unknown" || right.kind === "unknown") {
    return Object.freeze({ kind: "unknown" });
  }
  return joinIntervalForm(left, right);
}

function joinIntervalForm(
  left: Extract<ValidTimeForm, { kind: "bounded" | "open" }>,
  right: Extract<ValidTimeForm, { kind: "bounded" | "open" }>
): Extract<ValidTimeForm, { kind: "bounded" | "open" }> {
  const from = Math.min(left.from, right.from);
  if (left.kind === "open" || right.kind === "open") {
    return Object.freeze({ kind: "open", from });
  }
  return Object.freeze({ kind: "bounded", from, to: Math.max(left.to, right.to) });
}

function intervalOrTimeless(
  value: Exclude<ValidTimeForm, { kind: "unknown" }>
): Extract<ValidTimeForm, { kind: "bounded" | "open" }> | "timeless" {
  if (value.kind === "timeless") return "timeless";
  return value;
}

function timeEqual(left: ValidTimeForm | TransactionTimeForm, right: ValidTimeForm | TransactionTimeForm): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "timeless" || left.kind === "unknown") return true;
  if (left.kind === "open" && right.kind === "open") return left.from === right.from;
  if (left.kind === "bounded" && right.kind === "bounded") {
    return left.from === right.from && left.to === right.to;
  }
  return false;
}
