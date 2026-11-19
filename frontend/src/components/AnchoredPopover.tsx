import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Button } from './ui';
import './anchored-popover.css';
import { layoutRect, layoutViewport, uiScale } from '../lib/displayScale';

/** A nonmodal, downward detail surface. The top layer keeps its parent unchanged. */
export default function AnchoredPopover({ title, icon, children, className = '' }: {
  title: string; icon?: React.ReactNode; children: React.ReactNode; className?: string;
}) {
  const id = useId();
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const pageRoom = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  function position(ensureRoom = false) {
    if (!trigger.current || !panel.current) return;
    const bottomInset = window.innerWidth < 768 ? 92 : 16;
    const viewport = layoutViewport();
    const scale = uiScale();
    let anchor = layoutRect(trigger.current);
    const header = document.querySelector('.app-header');
    const headerBottom = header ? layoutRect(header).bottom : 0;
    const readableHeight = Math.max(64, Math.min(440, Math.round(viewport.height * .45), viewport.height - bottomInset - headerBottom - anchor.height - 24));
    if (ensureRoom && viewport.height - anchor.bottom - bottomInset - 8 < readableHeight) {
      const moveBy = anchor.bottom - (viewport.height - bottomInset - 8 - readableHeight);
      const scrolling = document.scrollingElement || document.documentElement;
      const missingRoom = Math.max(0, (window.scrollY + moveBy * scale - (scrolling.scrollHeight - window.innerHeight)) / scale);
      if (missingRoom > 0) {
        // Add room after the app, so a downward panel stays readable at the page end.
        // This spacer never participates in either dashboard card's layout.
        const spacer = document.createElement('div');
        spacer.className = 'anchored-popover-page-room';
        spacer.setAttribute('aria-hidden', 'true');
        spacer.style.height = `${missingRoom + 16}px`;
        document.body.appendChild(spacer);
        pageRoom.current = spacer;
      }
      window.scrollBy({ top: moveBy * scale, behavior: 'instant' });
      anchor = layoutRect(trigger.current);
    }
    const width = Math.min(480, viewport.width - 32);
    const left = Math.max(16, Math.min(anchor.right - width, viewport.width - width - 16));
    const top = anchor.bottom + 8;
    panel.current.style.setProperty('--popover-left', `${left}px`);
    panel.current.style.setProperty('--popover-top', `${top}px`);
    panel.current.style.setProperty('--popover-width', `${width}px`);
    panel.current.style.setProperty('--popover-height', `${Math.max(64, Math.min(440, viewport.height - top - bottomInset))}px`);
  }

  function releaseRoom() {
    pageRoom.current?.remove();
    pageRoom.current = null;
  }

  useEffect(() => () => releaseRoom(), []);

  useEffect(() => {
    if (!expanded) return;
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => position()); };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [expanded]);

  function close() {
    panel.current?.hidePopover?.();
    trigger.current?.focus({ preventScroll: true });
  }

  return <div className={`anchored-popover ${className}`}>
    <Button ref={trigger} variant="ghost" className="anchored-popover-trigger" popoverTarget={id}
      aria-haspopup="dialog" aria-expanded={expanded} aria-controls={id}>
      <span>{icon}{title}</span><ChevronDown size={19} aria-hidden="true" />
    </Button>
    <div ref={panel} id={id} popover="auto" className="anchored-popover-panel" role="dialog" aria-modal="false" aria-labelledby={headingId} tabIndex={-1}
      onBeforeToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'open') position(true); }}
      onToggle={event => {
        const open = (event.nativeEvent as ToggleEvent).newState === 'open';
        setExpanded(open);
        if (open) { if (panel.current) panel.current.scrollTop = 0; panel.current?.focus({ preventScroll: true }); }
        else { releaseRoom(); if (panel.current?.contains(document.activeElement)) trigger.current?.focus({ preventScroll: true }); }
      }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); } }}>
      <div className="anchored-popover-heading"><h3 id={headingId}>{title}</h3><Button variant="ghost" size="icon" aria-label={`关闭${title}`} onClick={close}><X size={18} aria-hidden="true" /></Button></div>
      <div className="anchored-popover-content">{children}</div>
    </div>
  </div>;
}
