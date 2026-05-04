import { defineConfig } from "vitest/config";
import projects from "./vitest.workspace.mjs";

const hasProjects = projects.length > 0;

export default defineConfig({
  test: {
    ...(hasProjects
      ? { projects }
      : { include: ["__no_tests__/**/*.test.ts"], passWithNoTests: true }),
    reporters: ["default"],
  },
});
