import React, { useEffect, useId, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import './guard-place-picker.css';
import { layoutRect, layoutViewport } from '../../lib/displayScale';

export default function RadiusInfoHint({ descriptionId, disabled = false }: { descriptionId: string; disabled?: boolean }) {
  const popupId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [fallback, setFallback] = useState(false);
  const openRef = useRef(false);

  function position() {
    if (!trigger.current || !panel.current) return;
    const anchor = layoutRect(trigger.current);
    const viewport = layoutViewport();
    const width = Math.min(310, viewport.width - 32);
    const height = Math.min(160, panel.current.scrollHeight || 100);
    const left = Math.max(16, Math.min(anchor.left, viewport.width - width - 16));
    const top = anchor.bottom + 8 + height <= viewport.height - 16
      ? anchor.bottom + 8 : Math.max(16, anchor.top - height - 8);
    panel.current.style.setProperty('--radius-hint-left', `${left}px`);
    panel.current.style.setProperty('--radius-hint-top', `${top}px`);
    panel.current.style.setProperty('--radius-hint-width', `${width}px`);
  }

  function close(returnFocus = false) {
    openRef.current = false;
    try { panel.current?.hidePopover?.(); } catch { /* Already closed or using the fallback. */ }
    setExpanded(false);
    if (returnFocus) trigger.current?.focus({ preventScroll: true });
  }

  function toggle() {
    if (disabled) return;
    if (openRef.current) { close(true); return; }
    position();
    openRef.current = true;
    setExpanded(true);
    const native = typeof panel.current?.showPopover === 'function';
    setFallback(!native);
    if (native) panel.current?.showPopover();
  }

  useEffect(() => { if (disabled && openRef.current) close(); }, [disabled]);
  useEffect(() => {
    if (!expanded) return;
    position();
    panel.current?.focus({ preventScroll: true });
    let frame = 0;
    const update = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(position); };
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !openRef.current) return;
      event.preventDefault();
      // This hint lives inside the area editor: one Escape closes only the hint.
      event.stopImmediatePropagation();
      close(true);
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', escape, true);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [expanded]);

  return <>
    <button ref={trigger} type="button" className="guard-radius-info-button" disabled={disabled} onClick={toggle}
      aria-label="半径说明" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={popupId}>
      <Info size={20} strokeWidth={1.7} aria-hidden="true" />
    </button>
    <div ref={panel} id={popupId} popover="auto" className="guard-radius-info-popover" role="dialog" aria-modal="false" aria-label="半径说明" tabIndex={-1}
      data-fallback-open={fallback && expanded ? 'true' : undefined}
      onBeforeToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'open') position(); }}
      onToggle={event => {
        const open = (event.nativeEvent as ToggleEvent).newState === 'open';
        openRef.current = open;
        setExpanded(open);
        if (!open && panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true });
      }}>
      <p id={descriptionId}>以所选地点为中心，地图圆圈显示区域范围。</p>
    </div>
  </>;
}
