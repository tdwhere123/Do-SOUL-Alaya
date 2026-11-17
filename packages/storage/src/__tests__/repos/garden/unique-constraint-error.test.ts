import { expect, it } from "vitest";
import { isUniqueConstraintError } from "@do-soul/alaya-protocol";
import { isUniqueConstraintError as storageReexport } from "../../../repos/garden/garden-task-errors.js";

it("re-exports the protocol owner of SQLITE_CONSTRAINT_UNIQUE classification", () => {
  expect(storageReexport).toBe(isUniqueConstraintError);
});
