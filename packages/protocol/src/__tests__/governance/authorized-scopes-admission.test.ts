import { describe, expect, it } from "vitest";
import {
  AuthorizedScopesAdmissionSchema,
  normalizeActiveConstraintAdmission,
  type AuthorizedScopesAdmission
} from "@do-soul/alaya-protocol";

const unrestricted: AuthorizedScopesAdmission = { mode: "unrestricted" };
const denied: AuthorizedScopesAdmission = { mode: "denied" };
const named: AuthorizedScopesAdmission = { mode: "named", scopes: ["project"] };

const cases: ReadonlyArray<{
  readonly name: string;
  readonly value: unknown;
  readonly ok: boolean;
  readonly mode?: "unrestricted" | "denied" | "named";
}> = [
  { name: "unrestricted", value: { mode: "unrestricted" }, ok: true, mode: "unrestricted" },
  { name: "denied", value: { mode: "denied" }, ok: true, mode: "denied" },
  { name: "named", value: { mode: "named", scopes: ["project"] }, ok: true, mode: "named" },
  { name: "JSON null", value: null, ok: false },
  { name: "omitted undefined", value: undefined, ok: false },
  { name: "empty array", value: [], ok: false },
  { name: "raw named array", value: ["project"], ok: false },
  { name: "empty named scopes", value: { mode: "named", scopes: [] }, ok: false },
  { name: "unknown mode", value: { mode: "all" }, ok: false },
  { name: "extra key on unrestricted", value: { mode: "unrestricted", extra: true }, ok: false }
];

describe("AuthorizedScopesAdmissionSchema", () => {
  it("keeps named denied and unrestricted as distinct assignable modes", () => {
    expect(AuthorizedScopesAdmissionSchema.parse(unrestricted).mode).toBe("unrestricted");
    expect(AuthorizedScopesAdmissionSchema.parse(denied).mode).toBe("denied");
    expect(AuthorizedScopesAdmissionSchema.parse(named)).toEqual(named);
  });

  it.each(cases)("$name", ({ value, ok, mode }) => {
    const parsed = AuthorizedScopesAdmissionSchema.safeParse(value);
    expect(parsed.success).toBe(ok);
    if (ok && parsed.success) expect(parsed.data.mode).toBe(mode);
  });

  it("treats omitted and empty named admission as denied after normalize", () => {
    expect(normalizeActiveConstraintAdmission(undefined)).toEqual({ mode: "denied" });
    expect(normalizeActiveConstraintAdmission({ mode: "denied" })).toEqual({ mode: "denied" });
    expect(normalizeActiveConstraintAdmission({ mode: "unrestricted" })).toEqual({ mode: "unrestricted" });
    expect(normalizeActiveConstraintAdmission({ mode: "named", scopes: ["project", "project"] }))
      .toEqual({ mode: "named", scopes: ["project"] });
  });
});
