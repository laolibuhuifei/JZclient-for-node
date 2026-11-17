export const TILE_SIZE = 256;
export const MAX_MERCATOR_LATITUDE = 85.05112878;

export function clampLatitude(latitude: number) {
  return Math.max(-MAX_MERCATOR_LATITUDE, Math.min(MAX_MERCATOR_LATITUDE, latitude));
}

export function wrapLongitude(longitude: number) {
  return ((longitude + 180) % 360 + 360) % 360 - 180;
}

export function toTile(longitude: number, latitude: number, zoom: number) {
  const count = 2 ** zoom;
  const radians = clampLatitude(latitude) * Math.PI / 180;
  return {
    x: (longitude + 180) / 360 * count,
    y: (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * count,
  };
}

export function fromTile(x: number, y: number, zoom: number) {
  const count = 2 ** zoom;
  const mercator = Math.PI - 2 * Math.PI * y / count;
  return {
    longitude: wrapLongitude(x / count * 360 - 180),
    latitude: clampLatitude(Math.atan(Math.sinh(mercator)) * 180 / Math.PI),
  };
}

export function markerOffset(
  longitude: number, latitude: number,
  centerLongitude: number, centerLatitude: number, zoom: number,
) {
  const marker = toTile(longitude, latitude, zoom);
  const center = toTile(centerLongitude, centerLatitude, zoom);
  const count = 2 ** zoom;
  let x = marker.x - center.x;
  // Pick the closest copy of a position when the viewport crosses the date line.
  if (x > count / 2) x -= count;
  if (x < -count / 2) x += count;
  return { x: x * TILE_SIZE, y: (marker.y - center.y) * TILE_SIZE };
}
