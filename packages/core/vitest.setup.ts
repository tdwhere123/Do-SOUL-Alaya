import { beforeEach } from "vitest";
import { resetCoreConfigForTests } from "./src/config/install-core-config.js";

beforeEach(() => {
  resetCoreConfigForTests();
});
