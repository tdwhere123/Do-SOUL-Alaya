import { z } from "zod";
import { SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import {
  assertSourceSemanticQueryMeaningBounds, type SourceSemanticQueryMeaningBody
} from "./semantic-query-meaning.js";

/** Producer vocabulary only; canonical referent semantics remain named/free. */
export const SOURCE_SEMANTIC_QUERY_REFERENT_KINDS = Object.freeze({
  named: "query_referent_constraint", free: "no_referent_constraint"
} as const);

type Projection = "encode" | "decode";
type JsonContainer = Record<string, unknown> | unknown[];

function projectKind(kind: unknown, projection: Projection): unknown {
  for (const [canonical, presented] of Object.entries(SOURCE_SEMANTIC_QUERY_REFERENT_KINDS)) {
    const from = projection === "encode" ? canonical : presented;
    const to = projection === "encode" ? presented : canonical;
    if (kind === from) return to;
    if (kind === to) {
      throw new z.ZodError([{ code: "custom", path: ["kind"], message: "mixed query referent presentation" }]);
    }
  }
  return kind;
}

function project(value: unknown, projection: Projection, sharedMeter?: SourceSemanticResourceLedger): unknown {
  const meter = sharedMeter ?? new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
  // The same ledger pays for the input traversal and output copy before either
  // schema parsing or canonical materialization can inspect the projection.
  meter.retain(value, "query referent presentation input");
  assertSourceSemanticQueryMeaningBounds(value);
  meter.retain(value, "query referent presentation copy");
  if (value === null || typeof value !== "object") return value;
  const root: JsonContainer = Array.isArray(value) ? [] : {};
  const pending = [{ source: value, target: root }];
  while (pending.length > 0) {
    const { source, target } = pending.pop()!;
    for (const [key, child] of Object.entries(source)) {
      const output = target as Record<string, unknown>;
      if (key === "kind" && typeof child === "string") {
        const kind = projectKind(child, projection) as string;
        meter.charge(0, Math.max(0, kind.length - child.length) * 4, "query referent vocabulary");
        output[key] = kind;
      } else if (child !== null && typeof child === "object") {
        const copy: JsonContainer = Array.isArray(child) ? [] : {};
        Object.defineProperty(output, key, { value: copy, enumerable: true, writable: true, configurable: true });
        pending.push({ source: child, target: copy });
      } else {
        Object.defineProperty(output, key, { value: child, enumerable: true, writable: true, configurable: true });
      }
    }
  }
  assertSourceSemanticQueryMeaningBounds(root);
  return root;
}

/** Render explicit choices, including incorrect ones; never inspect excerpts or local keys. */
export function encodeSourceSemanticQueryReferentConstraints(body: SourceSemanticQueryMeaningBody): unknown {
  return project(body, "encode");
}

/** Decode the selected vocabulary only; the existing meaning compiler validates semantics. */
export function decodeSourceSemanticQueryReferentConstraints(
  body: unknown, meter?: SourceSemanticResourceLedger
): unknown {
  return project(body, "decode", meter);
}
