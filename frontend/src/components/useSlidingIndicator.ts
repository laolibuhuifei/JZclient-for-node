import { RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import './sliding-indicator.css';
import { layoutRect } from '../lib/displayScale';

type IndicatorMode = 'navigation' | 'tabs';
type IndicatorRect = { left: number; top: number; width: number; height: number };

// One small background layer moves between controls. Geometry is read only on
// selection/layout changes; WAAPI handles all intermediate animation frames.
export function useSlidingIndicator(containerRef: RefObject<HTMLElement | null>, value: string | undefined, mode: IndicatorMode, layoutKey = '') {
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const valueRef = useRef(value); valueRef.current = value;
  const previousValue = useRef<string | undefined>(undefined);
  const previousLayout = useRef(layoutKey);
  const animationRef = useRef<Animation | null>(null);
  const reducedMotion = useRef<MediaQueryList | null>(null);
  const visible = useRef(true);

  const cancelAnimation = useCallback(() => {
    animationRef.current?.cancel();
    animationRef.current = null;
    if (indicatorRef.current) indicatorRef.current.style.willChange = '';
  }, []);

  const position = useCallback((animate: boolean, reveal = false) => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;
    const selector = mode === 'navigation' ? 'button[data-nav-value]' : 'button[role="tab"]';
    const button = Array.from(container.querySelectorAll<HTMLButtonElement>(selector))
      .find(item => (mode === 'navigation' ? item.dataset.navValue : item.dataset.tabValue) === valueRef.current);
    if (!button) {
      cancelAnimation();
      delete container.dataset.selectionReady;
      indicator.style.visibility = 'hidden';
      return;
    }
    const target = mode === 'navigation' && window.innerWidth < 768 ? button.querySelector('svg') || button : button;
    const parentBounds = layoutRect(container);
    const targetBounds = layoutRect(target);
    if (!targetBounds.width || !targetBounds.height) return;
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;
    const originLeft = parentBounds.left + container.clientLeft;
    const originTop = parentBounds.top + container.clientTop;
    const rect: IndicatorRect = {
      left: targetBounds.left - originLeft + scrollLeft,
      top: targetBounds.top - originTop + scrollTop,
      width: targetBounds.width,
      height: targetBounds.height,
    };
    const ready = container.dataset.selectionReady === 'true';
    const currentBounds = ready ? layoutRect(indicator) : null;
    const previous: IndicatorRect | null = currentBounds && currentBounds.width && currentBounds.height ? {
      left: currentBounds.left - originLeft + scrollLeft,
      top: currentBounds.top - originTop + scrollTop,
      width: currentBounds.width,
      height: currentBounds.height,
    } : null;
    const clientWidth = container.clientWidth;
    const clientHeight = container.clientHeight;
    const scrollWidth = container.scrollWidth;
    const scrollHeight = container.scrollHeight;
    let nextLeft = scrollLeft;
    let nextTop = scrollTop;
    if (reveal && clientWidth && scrollWidth > clientWidth) {
      if (rect.left < scrollLeft) nextLeft = Math.max(0, rect.left - 4);
      else if (rect.left + rect.width > scrollLeft + clientWidth) nextLeft = rect.left + rect.width - clientWidth + 4;
    }
    if (reveal && clientHeight && scrollHeight > clientHeight) {
      if (rect.top < scrollTop) nextTop = Math.max(0, rect.top - 4);
      else if (rect.top + rect.height > scrollTop + clientHeight) nextTop = rect.top + rect.height - clientHeight + 4;
    }
    // Some full-width tab rows scroll in an outer wrapper (the My categories).
    // Reveal the chosen control there too, without scrolling the whole page.
    let outerReveal: { element: HTMLElement; left: number } | null = null;
    if (reveal && mode === 'tabs') {
      let outer = container.parentElement;
      while (outer && outer !== document.body) {
        if (outer.clientWidth && outer.scrollWidth > outer.clientWidth && ['auto', 'scroll'].includes(window.getComputedStyle(outer).overflowX)) {
          const bounds = layoutRect(outer);
          const left = bounds.left + outer.clientLeft;
          const right = left + outer.clientWidth;
          const delta = targetBounds.left < left ? targetBounds.left - left - 4 : targetBounds.right > right ? targetBounds.right - right + 4 : 0;
          if (delta) outerReveal = { element: outer, left: Math.max(0, outer.scrollLeft + delta) };
          break;
        }
        outer = outer.parentElement;
      }
    }

    // All geometry reads precede writes, including interrupted animations.
    cancelAnimation();
    if (nextLeft !== scrollLeft) container.scrollLeft = nextLeft;
    if (nextTop !== scrollTop) container.scrollTop = nextTop;
    if (outerReveal) outerReveal.element.scrollLeft = outerReveal.left;
    const destination = `translate(${rect.left}px, ${rect.top}px)`;
    indicator.style.width = `${rect.width}px`;
    indicator.style.height = `${rect.height}px`;
    indicator.style.transform = destination;
    indicator.style.visibility = 'visible';
    container.dataset.selectionReady = 'true';
    const changed = previous && (Math.abs(previous.left - rect.left) > .25 || Math.abs(previous.top - rect.top) > .25
      || Math.abs(previous.width - rect.width) > .25 || Math.abs(previous.height - rect.height) > .25);
    if (!animate || !changed || document.hidden || !visible.current || reducedMotion.current?.matches || typeof indicator.animate !== 'function') return;
    indicator.style.willChange = 'transform';
    const animation = indicator.animate([
      { transform: `translate(${previous.left}px, ${previous.top}px) scale(${previous.width / rect.width}, ${previous.height / rect.height})` },
      { transform: destination },
    ], { duration: 200, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    animationRef.current = animation;
    const finish = () => {
      if (animationRef.current !== animation) return;
      animationRef.current = null;
      indicator.style.willChange = '';
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  }, [containerRef, mode, cancelAnimation]);

  useLayoutEffect(() => {
    const changed = previousValue.current !== value && previousLayout.current === layoutKey;
    previousValue.current = value;
    previousLayout.current = layoutKey;
    position(changed, true);
  }, [value, layoutKey, position]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame: number | null = null;
    let disposed = false;
    const schedule = () => {
      if (disposed || frame != null) return;
      frame = window.requestAnimationFrame(() => { frame = null; position(false, true); });
    };
    const preference = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    reducedMotion.current = preference;
    const stop = () => { if (document.hidden || preference?.matches || !visible.current) cancelAnimation(); };
    preference?.addEventListener?.('change', stop);
    document.addEventListener('visibilitychange', stop);
    window.addEventListener('resize', schedule);
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    resize?.observe(container);
    container.querySelectorAll(mode === 'navigation' ? 'button[data-nav-value]' : 'button[role="tab"]').forEach(button => resize?.observe(button));
    const intersection = typeof IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      visible.current = entries.some(entry => entry.isIntersecting);
      stop();
    }) : null;
    intersection?.observe(container);
    void document.fonts?.ready.then(schedule);
    return () => {
      disposed = true;
      if (frame != null) window.cancelAnimationFrame(frame);
      resize?.disconnect();
      intersection?.disconnect();
      preference?.removeEventListener?.('change', stop);
      document.removeEventListener('visibilitychange', stop);
      window.removeEventListener('resize', schedule);
      reducedMotion.current = null;
      cancelAnimation();
    };
  }, [containerRef, mode, layoutKey, position, cancelAnimation]);

  return indicatorRef;
}
