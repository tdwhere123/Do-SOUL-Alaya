import { useEffect, useState } from "react";

interface UseFpsMonitorOptions {
  readonly enabled: boolean;
  readonly threshold?: number;
  readonly lowFrameCount?: number;
  readonly recoveredFrameCount?: number;
}

/**
 * Tracks frame cadence for the 3D graph and flips to `true` after a sustained
 * run of low-FPS samples so the page can surface its degradation hint.
 */
export function useFpsMonitor({
  enabled,
  threshold = 30,
  lowFrameCount = 15,
  recoveredFrameCount = 15
}: UseFpsMonitorOptions): boolean {
  const [lowFpsDetected, setLowFpsDetected] = useState(false);

  useEffect(() => {
    if (!enabled || typeof window.requestAnimationFrame !== "function") {
      setLowFpsDetected(false);
      return;
    }

    let frameId = 0;
    let last = 0;
    let lowFrames = 0;
    let recoveredFrames = 0;
    let visible = false;
    const sampleFrame = (timestamp: number) => {
      const next = nextFpsSample(timestamp, last, {
        lowFrames,
        lowFrameCount,
        recoveredFrames,
        recoveredFrameCount,
        threshold,
        visible
      });
      if (next !== null) {
        lowFrames = next.lowFrames;
        recoveredFrames = next.recoveredFrames;
        visible = updateFpsVisibility(visible, next.visible, setLowFpsDetected);
      }
      last = timestamp;
      frameId = window.requestAnimationFrame(sampleFrame);
    };

    frameId = window.requestAnimationFrame(sampleFrame);
    return () => window.cancelAnimationFrame(frameId);
  }, [enabled, lowFrameCount, recoveredFrameCount, threshold]);

  return lowFpsDetected;
}

function nextFpsSample(
  timestamp: number,
  last: number,
  state: {
    readonly lowFrames: number;
    readonly lowFrameCount: number;
    readonly recoveredFrames: number;
    readonly recoveredFrameCount: number;
    readonly threshold: number;
    readonly visible: boolean;
  }
): { readonly lowFrames: number; readonly recoveredFrames: number; readonly visible: boolean } | null {
  if (last <= 0) return null;
  const fps = frameFps(timestamp, last, state.threshold);
  return fps < state.threshold ? lowFpsSample(state) : recoveredFpsSample(state);
}

function lowFpsSample(state: {
  readonly lowFrames: number;
  readonly lowFrameCount: number;
  readonly visible: boolean;
}) {
  const lowFrames = state.lowFrames + 1;
  return {
    lowFrames,
    recoveredFrames: 0,
    visible: lowFrames >= state.lowFrameCount ? true : state.visible
  };
}

function recoveredFpsSample(state: {
  readonly recoveredFrames: number;
  readonly recoveredFrameCount: number;
  readonly visible: boolean;
}) {
  const recoveredFrames = state.recoveredFrames + 1;
  return {
    lowFrames: 0,
    recoveredFrames,
    visible: recoveredFrames >= state.recoveredFrameCount ? false : state.visible
  };
}

function updateFpsVisibility(
  current: boolean,
  next: boolean,
  setLowFpsDetected: (value: boolean) => void
): boolean {
  if (current !== next) setLowFpsDetected(next);
  return next;
}

function frameFps(timestamp: number, last: number, threshold: number): number {
  const delta = timestamp - last;
  return delta > 0 ? 1000 / delta : threshold;
}
