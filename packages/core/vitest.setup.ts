import { beforeEach } from "vitest";
import { resetCoreConfigForTests } from "./src/runtime/config/install-core-config.js";

beforeEach(() => {
  resetCoreConfigForTests();
});
