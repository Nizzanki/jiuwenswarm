import { useEffect, useState } from 'react';

/** Track an element's content-box width via ResizeObserver.
 *  Returns [ref, width]. The ref is a callback ref so the observer also
 *  attaches for components that render nothing (early `return null`) on their
 *  first paint — a plain ref object would stay null forever in that case,
 *  because the mount effect already ran. Width starts at `fallback` until the
 *  observer fires, so SVGs sized from it have a sane first paint. */
export function useElementWidth<T extends HTMLElement>(fallback = 600) {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(entries => {
      for (const e of entries) setWidth(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}
