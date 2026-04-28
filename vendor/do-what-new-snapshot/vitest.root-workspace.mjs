import { defineWorkspace } from "vitest/config";
import {
  createAppProject,
  createCoreProject,
  createCoreDaemonProject,
  createEngineGatewayProject,
  createProtocolProject,
  createSoulProject,
  createStorageProject,
  createSurfaceRuntimeProject,
  createTuiProject,
  createUiSdkProject,
  rootDir,
} from "./vitest.config.mjs";

export default defineWorkspace([
  createProtocolProject(rootDir),
  createSoulProject(rootDir),
  createStorageProject(rootDir),
  createAppProject(rootDir),
  createTuiProject(rootDir),
  createUiSdkProject(rootDir),
  createSurfaceRuntimeProject(rootDir),
  createCoreProject(rootDir),
  createEngineGatewayProject(rootDir),
  createCoreDaemonProject(rootDir)
]);
