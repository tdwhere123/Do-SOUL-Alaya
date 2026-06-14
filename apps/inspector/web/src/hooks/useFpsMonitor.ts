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

    const update = (next: boolean) => {
      if (visible === next) return;
      visible = next;
      setLowFpsDetected(next);
    };

    const sampleFrame = (timestamp: number) => {
      if (last > 0) {
        const delta = timestamp - last;
        const fps = delta > 0 ? 1000 / delta : threshold;
        if (fps < threshold) {
          lowFrames += 1;
          recoveredFrames = 0;
          if (lowFrames >= lowFrameCount) {
            update(true);
          }
        } else {
          lowFrames = 0;
          recoveredFrames += 1;
          if (recoveredFrames >= recoveredFrameCount) {
            update(false);
          }
        }
      }

      last = timestamp;
      frameId = window.requestAnimationFrame(sampleFrame);
    };

    frameId = window.requestAnimationFrame(sampleFrame);
    return () => window.cancelAnimationFrame(frameId);
  }, [enabled, lowFrameCount, recoveredFrameCount, threshold]);

  return lowFpsDetected;
}
