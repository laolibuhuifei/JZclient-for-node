import { clampLatitude, fromTile, TILE_SIZE, toTile, wrapLongitude } from './mapMath';

export type MapView = { latitude: number; longitude: number; zoom: number };
export type MapOffset = { x: number; y: number };
export type MapMotionState = { view: MapView; target: MapView; animating: boolean };
export const MIN_MAP_ZOOM = 3;
export const MAX_MAP_ZOOM = 19;
export const MAP_ZOOM_DURATION = 260;

export function validMapView(view: MapView): MapView {
  const longitude = Number.isFinite(view.longitude) ? view.longitude : 0;
  return {
    latitude: clampLatitude(Number.isFinite(view.latitude) ? view.latitude : 0),
    longitude: longitude >= -180 && longitude < 180 ? longitude : wrapLongitude(longitude),
    zoom: Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, Number.isFinite(view.zoom) ? view.zoom : 16)),
  };
}

/** Offset is measured from the visible viewport center, in CSS pixels. */
export function pointAtOffset(view: MapView, offset: MapOffset) {
  if (offset.x === 0 && offset.y === 0) return { latitude: view.latitude, longitude: view.longitude };
  const center = toTile(view.longitude, view.latitude, view.zoom);
  return fromTile(center.x + offset.x / TILE_SIZE, center.y + offset.y / TILE_SIZE, view.zoom);
}

export function viewForAnchor(point: { latitude: number; longitude: number }, zoom: number, offset: MapOffset): MapView {
  if (offset.x === 0 && offset.y === 0) return { ...point, zoom };
  const anchor = toTile(point.longitude, point.latitude, zoom);
  return { ...fromTile(anchor.x - offset.x / TILE_SIZE, anchor.y - offset.y / TILE_SIZE, zoom), zoom };
}

export function radiusInPixels(radius: number | undefined, latitude: number, zoom: number) {
  if (!Number.isFinite(radius) || Number(radius) <= 0) return 0;
  return Number(radius) / (156543.03392 * Math.cos(clampLatitude(latitude) * Math.PI / 180) / 2 ** zoom);
}

/** One authoritative view drives tiles, marker, range, hit testing and interruption. */
export function createMapMotion(initial: MapView, publish: (state: MapMotionState) => void, clock: {
  now: () => number;
  request: (callback: FrameRequestCallback) => number;
  cancel: (frame: number) => void;
  allowsMotion: () => boolean;
}) {
  let current = validMapView(initial);
  let target = current;
  let frame: number | null = null;
  let animating = false;
  let sequence = 0;

  const notify = () => publish({ view: current, target, animating });
  function cancel() {
    sequence++;
    if (frame !== null) clock.cancel(frame);
    frame = null;
    animating = false;
  }
  function set(view: MapView) {
    cancel();
    current = target = validMapView(view);
    notify();
  }
  function stop(finish = false) { set(finish ? target : current); }
  function zoomBy(amount: number, offset: MapOffset = { x: 0, y: 0 }) {
    if (!Number.isFinite(amount) || amount === 0) return;
    const nextZoom = Math.max(MIN_MAP_ZOOM, Math.min(MAX_MAP_ZOOM, target.zoom + amount));
    if (nextZoom === target.zoom) return;
    const start = current;
    const anchor = pointAtOffset(start, offset);
    cancel();
    target = validMapView(viewForAnchor(anchor, nextZoom, offset));
    if (!clock.allowsMotion() || Math.abs(start.zoom - nextZoom) < .00001) { set(target); return; }
    const started = clock.now();
    const run = sequence;
    animating = true;
    notify();
    function advance(now: number) {
      if (run !== sequence) return;
      frame = null;
      if (!clock.allowsMotion()) { set(target); return; }
      const progress = Math.max(0, Math.min(1, (now - started) / MAP_ZOOM_DURATION));
      const eased = 1 - (1 - progress) ** 3;
      const zoom = start.zoom + (nextZoom - start.zoom) * eased;
      current = progress === 1 ? target : validMapView(viewForAnchor(anchor, zoom, offset));
      animating = progress !== 1;
      notify();
      if (animating) frame = clock.request(advance);
    }
    frame = clock.request(advance);
  }
  return {
    get current() { return current; },
    get target() { return target; },
    set, stop, zoomBy,
    dispose: cancel,
  };
}
