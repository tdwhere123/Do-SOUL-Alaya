import { useEffect, useState, type RefObject } from "react";

const DEFAULT_VIEWPORT = { width: 800, height: 600 };

export function useViewportSize(ref: RefObject<HTMLElement | null>) {
  const [viewport, setViewport] = useState(DEFAULT_VIEWPORT);

  useEffect(() => {
    if (!ref.current) return;

    const element = ref.current;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setViewport({
        width: rect.width > 0 ? rect.width : DEFAULT_VIEWPORT.width,
        height: rect.height > 0 ? rect.height : DEFAULT_VIEWPORT.height
      });
    });

    observer.observe(element);
    const initialRect = element.getBoundingClientRect();
    setViewport({
      width: initialRect.width > 0 ? initialRect.width : DEFAULT_VIEWPORT.width,
      height: initialRect.height > 0 ? initialRect.height : DEFAULT_VIEWPORT.height
    });

    return () => observer.disconnect();
  }, [ref]);

  return viewport;
}
