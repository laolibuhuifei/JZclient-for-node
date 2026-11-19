import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Info } from 'lucide-react';
import { Button } from '../components/ui';
import { BatteryOutline, BatteryRing, OnlineBadge } from './HomePageParts';
import './home-watch-picker.css';
import { layoutRect, layoutViewport, uiScale } from '../lib/displayScale';

type WatchSummary = { watchId: string | number; name?: string; model?: string; battery?: unknown; online?: unknown };
type Props = { watches: WatchSummary[]; selectedId: string; onSelect: (id: string) => void; onInfo: (id: string) => void; variant?: 'home' | 'compact' | 'title' };

function WatchChoice({ watch, selected, onSelect, onInfo, showFullName = false }: { watch: WatchSummary; selected: boolean; onSelect: () => void; onInfo: () => void; showFullName?: boolean }) {
  const descriptionId = useId();
  const name = watch.name || '未命名手表';
  const letters = Array.from(name);
  const displayName = showFullName || letters.length <= 5 ? name : `${letters.slice(0, 5).join('')}...`;
  return <div className="home-watch-card" data-selected={selected}>
    <Button variant="ghost" className="home-watch-select" onClick={onSelect} aria-label={name} aria-describedby={descriptionId} aria-pressed={selected} title={name} />
    <span className="home-watch-copy">
      <span className="home-watch-name"><strong title={name}>{displayName}</strong><Button variant="ghost" size="icon" className="home-watch-info" aria-label={`查看${name}的设备信息`} aria-haspopup="dialog" title="查看设备信息" onClick={event => { event.currentTarget.focus({ preventScroll: true }); onInfo(); }}><Info size={17} strokeWidth={1.8} aria-hidden="true" /></Button>{selected && <Check size={16} aria-hidden="true" />}</span>
      <span className="home-watch-model" id={descriptionId}><span title={watch.model}>{watch.model || '型号待同步'}</span><OnlineBadge value={watch.online} /></span>
    </span>
    <BatteryRing value={watch.battery} compact />
    <BatteryOutline value={watch.battery} />
  </div>;
}

export default function HomeWatchPicker({ watches, selectedId, onSelect, onInfo, variant = 'home' }: Props) {
  const popoverId = useId();
  const headingId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const pageRoom = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const selected = watches.find(watch => String(watch.watchId) === selectedId);
  const primary = variant === 'compact' ? (selected ? [selected] : watches.slice(0, 1)) : watches.slice(0, 2);
  // Keep the active device visible after it is chosen from the overflow list.
  if (variant !== 'compact' && selected && !primary.some(watch => String(watch.watchId) === selectedId)) primary[1] = selected;
  const remaining = watches.filter(watch => !primary.some(item => String(item.watchId) === String(watch.watchId)));
  const showFullName = watches.length === 1;
  const singleNameLength = showFullName ? Array.from(primary[0]?.name || '未命名手表').length : 0;

  function releaseRoom() {
    pageRoom.current?.remove();
    pageRoom.current = null;
  }

  function positionPopover(ensureRoom = false) {
    if (!trigger.current || !popover.current || !picker.current) return;
    let anchor = layoutRect(trigger.current);
    const viewport = layoutViewport();
    const scale = uiScale();
    const bottomInset = window.innerWidth < 768 ? 96 : 24;
    if (variant !== 'home' && ensureRoom) {
      const header = document.querySelector('.app-header');
      const headerBottom = header ? layoutRect(header).bottom : 0;
      const readableHeight = Math.max(64, Math.min(384, viewport.height * .5, viewport.height - bottomInset - headerBottom - anchor.height - 24));
      const moveBy = anchor.bottom - (viewport.height - bottomInset - 8 - readableHeight);
      if (moveBy > 0) {
        const scrolling = document.scrollingElement || document.documentElement;
        const missingRoom = Math.max(0, (window.scrollY + moveBy * scale - (scrolling.scrollHeight - window.innerHeight)) / scale);
        if (missingRoom > 0) {
          releaseRoom();
          const spacer = document.createElement('div');
          spacer.className = 'watch-popover-page-room';
          spacer.setAttribute('aria-hidden', 'true');
          spacer.style.height = `${missingRoom + 16}px`;
          document.body.appendChild(spacer);
          pageRoom.current = spacer;
        }
        window.scrollBy({ top: moveBy * scale, behavior: 'instant' });
        anchor = layoutRect(trigger.current);
      }
    }
    const width = Math.min(360, variant === 'title' ? viewport.width - 32 : layoutRect(picker.current).width, viewport.width - 32);
    const left = Math.max(16, Math.min(anchor.right - width, viewport.width - width - 16));
    const top = anchor.bottom + 8;
    popover.current.style.setProperty('--watch-popover-left', `${left}px`);
    popover.current.style.setProperty('--watch-popover-top', `${top}px`);
    popover.current.style.setProperty('--watch-popover-width', `${width}px`);
    popover.current.style.setProperty('--watch-popover-height', `${Math.max(64, Math.min(384, viewport.height - top - bottomInset))}px`);
  }

  useEffect(() => () => releaseRoom(), []);

  useEffect(() => {
    if (!remaining.length && expanded) { popover.current?.hidePopover?.(); setExpanded(false); releaseRoom(); }
  }, [remaining.length, expanded]);

  useEffect(() => {
    if (!expanded) return;
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => positionPopover()); };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [expanded]);

  function chooseExtra(id: string) {
    popover.current?.hidePopover?.();
    trigger.current?.focus({ preventScroll: true });
    onSelect(id);
  }

  function inspectExtra(id: string) {
    popover.current?.hidePopover?.();
    trigger.current?.focus({ preventScroll: true });
    onInfo(id);
  }

  return <div className={`home-watch-picker${variant !== 'home' ? ` home-watch-picker-${variant}` : ''}`} ref={picker}
    style={singleNameLength ? { '--home-watch-single-ch': singleNameLength } as React.CSSProperties : undefined}>
    <div className="home-watch-row" data-has-more={remaining.length > 0}>
      <ul className="home-watch-primary" aria-label="选择当前手表">{primary.map(watch => <li key={watch.watchId}>
        <WatchChoice watch={watch} selected={String(watch.watchId) === selectedId} onSelect={() => onSelect(String(watch.watchId))} onInfo={() => onInfo(String(watch.watchId))} showFullName={showFullName} />
      </li>)}</ul>
      {remaining.length > 0 && <>
        <Button ref={trigger} variant="ghost" className="home-watch-more" popoverTarget={popoverId} aria-label="更多手表" aria-haspopup="dialog" aria-expanded={expanded} aria-controls={popoverId} title={`展开其余 ${remaining.length} 台手表`}>
          <ChevronDown size={21} aria-hidden="true" /><span>+{remaining.length}</span>
        </Button>
        <div ref={popover} id={popoverId} popover="auto" className="home-watch-popover" role="dialog" aria-modal="false" aria-labelledby={headingId} tabIndex={-1}
          onBeforeToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'open') positionPopover(true); }}
          onToggle={event => {
            const open = (event.nativeEvent as ToggleEvent).newState === 'open';
            setExpanded(open);
            if (open) { if (popover.current) popover.current.scrollTop = 0; popover.current?.querySelector<HTMLButtonElement>('.home-watch-select')?.focus({ preventScroll: true }); }
            else { releaseRoom(); if (popover.current?.contains(document.activeElement) || document.activeElement === document.body) trigger.current?.focus({ preventScroll: true }); }
          }}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popover.current?.hidePopover?.(); trigger.current?.focus({ preventScroll: true }); } }}>
          <div className="home-watch-popover-heading"><h3 id={headingId}>更多手表</h3><span>{remaining.length} 台</span></div>
          <ul className="home-watch-overflow" aria-label="其他手表">{remaining.map(watch => <li key={watch.watchId}>
            <WatchChoice watch={watch} selected={String(watch.watchId) === selectedId} onSelect={() => chooseExtra(String(watch.watchId))} onInfo={() => inspectExtra(String(watch.watchId))} showFullName={showFullName} />
          </li>)}</ul>
        </div>
      </>}
    </div>
  </div>;
}
