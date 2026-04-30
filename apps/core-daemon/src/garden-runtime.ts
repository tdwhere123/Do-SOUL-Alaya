import { BackgroundServiceManager, type BackgroundServiceConfig } from "./background/bootstrap.js";

export interface GardenBacklogTelemetryObserver {
  capture(): Promise<void>;
}

export interface GardenRuntimeTask {
  readonly name: string;
  readonly intervalMs: number;
  run(): Promise<void>;
}

export interface GardenBacklogTelemetrySource {
  getBacklogSnapshot(): unknown;
}

export function createGardenRuntime(input: {
  readonly tasks?: readonly GardenRuntimeTask[];
  readonly backlogTelemetrySource?: GardenBacklogTelemetrySource;
}): Readonly<{
  readonly backgroundManager: BackgroundServiceManager;
  readonly backlogTelemetrySource: GardenBacklogTelemetrySource;
  setBacklogTelemetryObserver(observer: GardenBacklogTelemetryObserver | null): void;
}> {
  let backlogTelemetryObserver: GardenBacklogTelemetryObserver | null = null;
  const services: BackgroundServiceConfig[] = (input.tasks ?? []).map((task) => ({
    name: task.name,
    intervalMs: task.intervalMs,
    task: async () => {
      await task.run();
      if (backlogTelemetryObserver !== null) {
        await backlogTelemetryObserver.capture();
      }
    }
  }));
  const backlogTelemetrySource =
    input.backlogTelemetrySource ??
    Object.freeze({
      getBacklogSnapshot: () => ({ tasks: [] })
    });

  return Object.freeze({
    backgroundManager: new BackgroundServiceManager(services),
    backlogTelemetrySource,
    setBacklogTelemetryObserver: (observer: GardenBacklogTelemetryObserver | null) => {
      backlogTelemetryObserver = observer;
    }
  });
}
