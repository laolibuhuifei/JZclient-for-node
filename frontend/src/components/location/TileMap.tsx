import React, { useEffect, useMemo, useRef, useState } from 'react';
import { LocateFixed, Map as MapIcon, MapPin, Maximize, Minimize, Minus, Plus, RefreshCw, Satellite } from 'lucide-react';
import { fromTile, markerOffset, TILE_SIZE, toTile } from './mapMath';
import { createMapMotion, MAX_MAP_ZOOM, MIN_MAP_ZOOM, pointAtOffset, radiusInPixels, type MapMotionState, type MapView } from './mapMotion';
import { mapTiles, projectMapTiles, type MapLayer, type MapTile } from './mapTiles';
import './location.css';
import './tile-map.css';
import { layoutRect, uiScale } from '../../lib/displayScale';
import { Modal } from '../ui';

export type MapCoordinates = { latitude: number; longitude: number };

type Props = {
  latitude: number;
  longitude: number;
  name?: string;
  radius?: number;
  onPick?: (point: MapCoordinates) => void;
  onViewChange?: (point: MapCoordinates) => void;
  recenterKey?: number;
  showMarker?: boolean;
  disabled?: boolean;
  selectionLabel?: string;
};

export default function TileMap({ latitude, longitude, name = '手表位置', radius, onPick, onViewChange, recenterKey, showMarker = true, disabled = false, selectionLabel = '区域中心' }: Props) {
  const mapElement = useRef<HTMLDivElement>(null);
  const fullscreenButton = useRef<HTMLButtonElement>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const [fullscreenBusy, setFullscreenBusy] = useState(false);
  const previousPageFullscreen = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; view: MapView; moved: boolean; pointerId: number } | null>(null);
  const previousRecenter = useRef(recenterKey);
  const visible = useRef(true);
  const reducedMotion = useRef(false);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;
  const [size, setSize] = useState({ width: 800, height: 440 });
  const [motionState, setMotionState] = useState<MapMotionState>(() => ({
    view: { latitude, longitude, zoom: 16 }, target: { latitude, longitude, zoom: 16 }, animating: false,
  }));
  const motionRef = useRef<ReturnType<typeof createMapMotion> | null>(null);
  if (!motionRef.current) motionRef.current = createMapMotion(motionState.view, setMotionState, {
    now: () => window.performance.now(),
    request: callback => window.requestAnimationFrame(callback),
    cancel: frame => window.cancelAnimationFrame(frame),
    allowsMotion: () => !disabledRef.current && !reducedMotion.current && visible.current && !document.hidden,
  });
  const motion = motionRef.current;
  const view = motionState.view;
  const [dragging, setDragging] = useState(false);
  const [layer, setLayer] = useState<MapLayer>('normal');
  const [retry, setRetry] = useState(0);
  const [baseRaster, setBaseRaster] = useState<{ zoom: number; layer: MapLayer; retry: number; tiles: MapTile[] }>(() => ({
    zoom: 16, layer: 'normal', retry: 0, tiles: mapTiles(motionState.view, size, 16, 'normal'),
  }));
  const [imageStates, setImageStates] = useState<Map<string, 'loaded' | 'failed'>>(new Map());
  const displayedImageKeys = useRef(new Set<string>());
  const selectable = !!onPick;

  useEffect(() => {
    if (previousPageFullscreen.current && !pageFullscreen) fullscreenButton.current?.focus({ preventScroll: true });
    previousPageFullscreen.current = pageFullscreen;
  }, [pageFullscreen]);

  useEffect(() => {
    let wasFullscreen = false;
    const changed = () => {
      const active = document.fullscreenElement === mapElement.current;
      setFullscreen(active);
      if (wasFullscreen && !active) fullscreenButton.current?.focus({ preventScroll: true });
      wasFullscreen = active;
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);

  const toggleFullscreen = async () => {
    if (fullscreenBusy) return;
    setFullscreenBusy(true);
    try {
      if (pageFullscreen) setPageFullscreen(false);
      else if (document.fullscreenElement === mapElement.current) await document.exitFullscreen();
      else if (mapElement.current?.requestFullscreen) await mapElement.current.requestFullscreen();
      else setPageFullscreen(true);
    } catch {
      // iOS and browsers that deny native fullscreen still get the full page.
      if (document.fullscreenElement !== mapElement.current) setPageFullscreen(true);
    } finally { setFullscreenBusy(false); }
  };

  useEffect(() => {
    if (!selectable) motion.set({ latitude, longitude, zoom: 16 });
    else if (recenterKey == null || recenterKey !== previousRecenter.current) motion.set({ ...motion.current, latitude, longitude });
    previousRecenter.current = recenterKey;
  }, [latitude, longitude, recenterKey, selectable, motion]);

  useEffect(() => { onViewChange?.({ latitude: view.latitude, longitude: view.longitude }); }, [view.latitude, view.longitude, onViewChange]);
  useEffect(() => { if (disabled) { drag.current = null; setDragging(false); motion.stop(true); } }, [disabled, motion]);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const preferenceChanged = () => {
      reducedMotion.current = !!media?.matches;
      if (reducedMotion.current) motion.stop(true);
    };
    preferenceChanged();
    media?.addEventListener?.('change', preferenceChanged);
    const visibilityChanged = () => { if (document.hidden) motion.stop(true); };
    document.addEventListener('visibilitychange', visibilityChanged);
    const observer = typeof window.IntersectionObserver === 'function'
      ? new window.IntersectionObserver(entries => {
        visible.current = entries.some(entry => entry.isIntersecting);
        if (!visible.current) motion.stop(true);
      }) : null;
    if (viewport.current) observer?.observe(viewport.current);
    return () => {
      motion.dispose();
      observer?.disconnect();
      media?.removeEventListener?.('change', preferenceChanged);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [motion, pageFullscreen]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => {
      const bounds = layoutRect(element);
      if (bounds.width && bounds.height) setSize({ width: bounds.width, height: bounds.height });
    };
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [pageFullscreen]);

  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (disabledRef.current || drag.current) return;
      const bounds = element.getBoundingClientRect();
      if (!bounds.width || !bounds.height || !event.deltaY) return;
      event.preventDefault();
      const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? bounds.height : 1);
      motion.zoomBy(Math.max(-1, Math.min(1, -pixels / 280)), {
        x: (event.clientX - bounds.left - bounds.width / 2) / uiScale(),
        y: (event.clientY - bounds.top - bounds.height / 2) / uiScale(),
      });
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [motion, pageFullscreen]);

  // Never enumerate a distant future raster at the current scale: a fast 19→3
  // zoom would otherwise attempt millions of high-resolution offscreen tiles.
  const minimumRaster = Math.max(MIN_MAP_ZOOM, Math.floor(view.zoom) - 1);
  const maximumRaster = Math.min(MAX_MAP_ZOOM, Math.ceil(view.zoom) + 1);
  const desiredZoom = Math.max(minimumRaster, Math.min(maximumRaster, Math.round(motionState.target.zoom)));
  const desiredTiles = useMemo(() => mapTiles(view, size, desiredZoom, layer, retry), [view, size, desiredZoom, layer, retry]);
  // Retain only the finite tiles from the prior raster. This both keeps a loaded
  // background during large zooms and avoids enumerating a distant raster level.
  const fallbackTiles = useMemo(() => baseRaster.layer === layer && baseRaster.retry === retry && baseRaster.zoom !== desiredZoom
    ? projectMapTiles(baseRaster.tiles, baseRaster.zoom, view, size) : [], [baseRaster, layer, retry, desiredZoom, view, size]);
  const grids = [{ zoom: desiredZoom, tiles: desiredTiles }, ...(fallbackTiles.length ? [{ zoom: baseRaster.zoom, tiles: fallbackTiles }] : [])];
  displayedImageKeys.current = new Set(grids.flatMap(grid => grid.tiles.map(tile => tile.imageKey)));
  const detailReady = desiredTiles.length > 0 && desiredTiles.every(tile => imageStates.get(tile.imageKey) === 'loaded');
  useEffect(() => {
    if (motionState.animating) return;
    const sameSource = baseRaster.layer === layer && baseRaster.retry === retry;
    if (!detailReady && sameSource && baseRaster.zoom !== desiredZoom) return;
    if (sameSource && baseRaster.zoom === desiredZoom && baseRaster.tiles === desiredTiles) return;
    setBaseRaster({ zoom: desiredZoom, layer, retry, tiles: desiredTiles });
  }, [motionState.animating, detailReady, baseRaster, desiredZoom, desiredTiles, layer, retry]);

  const offset = markerOffset(longitude, latitude, view.longitude, view.latitude, view.zoom);
  const marker = { x: size.width / 2 + offset.x, y: size.height / 2 + offset.y };
  const accuracy = radiusInPixels(radius, latitude, view.zoom);
  const unavailable = desiredTiles.length > 0 && desiredTiles.every(tile => imageStates.get(tile.imageKey) === 'failed');
  const stopDrag = () => { drag.current = null; setDragging(false); };
  const markImage = (key: string, value: 'loaded' | 'failed') => setImageStates(current => {
    if (current.get(key) === value) return current;
    const next = new Map(current);
    next.delete(key);
    next.set(key, value);
    if (next.size > 800) {
      const visible = [...next].filter(([key]) => displayedImageKeys.current.has(key));
      const recent = [...next].filter(([key]) => !displayedImageKeys.current.has(key)).slice(-Math.max(1, 500 - visible.length));
      return new Map([...recent, ...visible]);
    }
    return next;
  });
  const pickCenter = () => { motion.stop(); onPick?.({ latitude: motion.current.latitude, longitude: motion.current.longitude }); };

  const expanded = fullscreen || pageFullscreen;
  const content = <div ref={mapElement} className="location-map" data-fullscreen={expanded} data-selectable={selectable} data-layer={layer} data-zoom={view.zoom} data-target-zoom={motionState.target.zoom} data-animating={motionState.animating}>
    <div ref={viewport} className={`location-map-viewport${dragging ? ' is-dragging' : ''}`} role="region"
      aria-label={selectable ? `${selectionLabel}选择地图，点击选择位置，使用方向键移动，加减键或滚轮缩放，Enter 选择地图中心` : '手表位置地图，使用方向键移动地图，加减键或滚轮缩放'}
      aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0}
      onPointerDown={event => {
        if (disabled || event.button !== 0) return;
        event.currentTarget.focus({ preventScroll: true });
        motion.stop();
        drag.current = { x: event.clientX, y: event.clientY, view: motion.current, moved: false, pointerId: event.pointerId };
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* Pointer may already have ended. */ }
      }}
      onPointerMove={event => {
        if (disabled || !drag.current || drag.current.pointerId !== event.pointerId) return;
        const start = drag.current;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) start.moved = true;
        if (!start.moved) return;
        setDragging(true);
        const center = toTile(start.view.longitude, start.view.latitude, start.view.zoom);
        motion.set({ ...fromTile(center.x - (event.clientX - start.x) / (TILE_SIZE * uiScale()), center.y - (event.clientY - start.y) / (TILE_SIZE * uiScale()), start.view.zoom), zoom: start.view.zoom });
      }}
      onPointerUp={event => {
        const start = drag.current;
        if (!disabled && onPick && start && start.pointerId === event.pointerId && !start.moved && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 6) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (bounds.width && bounds.height) onPick(pointAtOffset(motion.current, {
            x: (event.clientX - bounds.left - bounds.width / 2) / uiScale(),
            y: (event.clientY - bounds.top - bounds.height / 2) / uiScale(),
          }));
        }
        stopDrag();
        if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={stopDrag} onLostPointerCapture={stopDrag}
      onKeyDown={event => {
        if (disabled) return;
        if (event.key === 'Enter' && onPick) { event.preventDefault(); pickCenter(); return; }
        if (event.key === '+' || event.key === '=') { event.preventDefault(); motion.zoomBy(1); return; }
        if (event.key === '-') { event.preventDefault(); motion.zoomBy(-1); return; }
        const direction: Record<string, [number, number]> = { ArrowLeft: [-.4, 0], ArrowRight: [.4, 0], ArrowUp: [0, -.4], ArrowDown: [0, .4] };
        if (!direction[event.key]) return;
        event.preventDefault();
        motion.stop();
        const current = motion.current;
        const center = toTile(current.longitude, current.latitude, current.zoom);
        const [x, y] = direction[event.key];
        motion.set({ ...fromTile(center.x + x, center.y + y, current.zoom), zoom: current.zoom });
      }}>
      {grids.map((grid, index) => <div key={`${layer}/${grid.zoom}/${retry}`} className="location-map-raster" data-raster-zoom={grid.zoom} style={{ zIndex: index === 0 ? 1 : 0 }} aria-hidden="true">
        {grid.tiles.map(tile => <img key={tile.key} className="location-map-tile" src={tile.url} alt="" draggable={false}
          style={{ transform: `translate3d(${tile.left}px, ${tile.top}px, 0) scale(${tile.scale})`, opacity: imageStates.get(tile.imageKey) === 'loaded' ? 1 : 0 }}
          onLoad={() => markImage(tile.imageKey, 'loaded')} onError={() => markImage(tile.imageKey, 'failed')} />)}
      </div>)}
      {selectable && <span className="location-map-center-target" aria-hidden="true" />}
      {showMarker && accuracy > 0 && <svg className="location-map-radius-overlay" width={size.width} height={size.height} viewBox={`0 0 ${size.width} ${size.height}`} aria-hidden="true">
        <circle className="location-accuracy-circle" cx={marker.x} cy={marker.y} r={accuracy} />
      </svg>}
      {showMarker && <div className="location-map-marker" style={{ left: marker.x, top: marker.y }}>
        <span className="location-map-pin" title={name}><MapPin size={23} aria-hidden="true" /><span className="sr-only">{name}</span></span>
      </div>}
    </div>
    <div className="location-map-layer-control" role="group" aria-label="地图图层">
      {(['normal', 'satellite'] as const).map(value => <button key={value} type="button" aria-label={value === 'normal' ? '普通地图' : '卫星地图'} title={value === 'normal' ? '普通地图' : '卫星地图'} aria-pressed={layer === value} disabled={disabled}
        onClick={() => {
          setLayer(value);
          const zoom = Math.round(motion.current.zoom);
          setBaseRaster({ layer: value, retry, zoom, tiles: mapTiles(motion.current, size, zoom, value, retry) });
        }}>
        {value === 'normal' ? <MapIcon size={18} aria-hidden="true" /> : <Satellite size={18} aria-hidden="true" />}
      </button>)}
    </div>
    <div className="location-map-tools" role="group" aria-label="地图控制">
      <button type="button" onClick={() => motion.zoomBy(1)} disabled={disabled || motionState.target.zoom >= MAX_MAP_ZOOM} title="放大" aria-label="放大地图"><Plus size={18} aria-hidden="true" /></button>
      <button type="button" onClick={() => motion.zoomBy(-1)} disabled={disabled || motionState.target.zoom <= MIN_MAP_ZOOM} title="缩小" aria-label="缩小地图"><Minus size={18} aria-hidden="true" /></button>
      <button type="button" onClick={() => motion.set({ latitude, longitude, zoom: selectable ? motion.current.zoom : 16 })} disabled={disabled}
        title={selectable ? showMarker ? `回到${selectionLabel}` : '回到初始视图' : '回到手表位置'} aria-label={selectable ? showMarker ? `回到${selectionLabel}` : '回到初始视图' : '回到手表位置'}><LocateFixed size={18} aria-hidden="true" /></button>
    </div>
    <button ref={fullscreenButton} type="button" className="location-map-fullscreen" onClick={toggleFullscreen} disabled={fullscreenBusy || (disabled && !expanded)}
      aria-label={expanded ? '退出地图全屏' : '全屏显示地图'} title={expanded ? '退出地图全屏' : '全屏显示地图'}>
      {expanded ? <Minimize size={18} aria-hidden="true" /> : <Maximize size={18} aria-hidden="true" />}
    </button>
    {onPick && <button type="button" className="location-map-pick-center" disabled={disabled} onClick={pickCenter}><MapPin size={18} aria-hidden="true" />使用地图中心</button>}
    <div className="location-map-provider">© 高德地图</div>
    {unavailable && <div className="location-map-unavailable" role="status">
      <span>{layer === 'satellite' ? '卫星影像暂时无法加载，可以重试或切换普通地图' : '地图暂时无法加载，位置信息仍可查看'}</span>
      <button type="button" disabled={disabled} onClick={() => { setImageStates(new Map()); setRetry(value => value + 1); }}><RefreshCw size={14} aria-hidden="true" />重新加载</button>
    </div>}
  </div>;
  return pageFullscreen ? <Modal open title="全屏地图" size="xl" className="map-fullscreen-modal" onClose={() => setPageFullscreen(false)}>{content}</Modal> : content;
}
