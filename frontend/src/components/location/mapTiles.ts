import { TILE_SIZE, toTile } from './mapMath';
import type { MapView } from './mapMotion';

export type MapLayer = 'normal' | 'satellite';
export type MapTile = { key: string; imageKey: string; url: string; x: number; y: number; left: number; top: number; scale: number };

export function mapTileUrl(layer: MapLayer, x: number, y: number, zoom: number, retry = 0) {
  const server = (x + y) % 4 + 1;
  // Both endpoints use the existing AMap GCJ-02 tile grid. style=6 was checked
  // against real imagery; style=8 on webst is NOT a transparent label layer.
  const base = layer === 'satellite'
    ? `https://webst0${server}.is.autonavi.com/appmaptile?style=6`
    : `https://webrd0${server}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8`;
  return `${base}&x=${x}&y=${y}&z=${zoom}${retry ? `&retry=${retry}` : ''}`;
}

/** Raster level stays integral; the full view and its scale may be fractional. */
export function mapTiles(view: MapView, size: { width: number; height: number }, rasterZoom: number, layer: MapLayer, retry = 0): MapTile[] {
  const count = 2 ** rasterZoom;
  const scale = 2 ** (view.zoom - rasterZoom);
  const tileSize = TILE_SIZE * scale;
  const center = toTile(view.longitude, view.latitude, rasterZoom);
  const cx = center.x * tileSize;
  const cy = center.y * tileSize;
  const list: MapTile[] = [];
  const startX = Math.floor((cx - size.width / 2) / tileSize);
  const endX = Math.floor((cx + size.width / 2) / tileSize);
  const startY = Math.floor((cy - size.height / 2) / tileSize);
  const endY = Math.floor((cy + size.height / 2) / tileSize);
  for (let x = startX; x <= endX; x++) {
    for (let y = startY; y <= endY; y++) {
      if (y < 0 || y >= count) continue;
      const wrappedX = ((x % count) + count) % count;
      list.push({
        key: `${layer}/${rasterZoom}/${x}/${y}/${retry}`,
        imageKey: `${layer}/${rasterZoom}/${wrappedX}/${y}/${retry}`,
        url: mapTileUrl(layer, wrappedX, y, rasterZoom, retry),
        x, y,
        left: x * tileSize - cx + size.width / 2,
        top: y * tileSize - cy + size.height / 2,
        scale,
      });
    }
  }
  return list;
}

/** Reproject the finite previous raster while replacement images are loading. */
export function projectMapTiles(tiles: MapTile[], rasterZoom: number, view: MapView, size: { width: number; height: number }) {
  const count = 2 ** rasterZoom;
  const scale = 2 ** (view.zoom - rasterZoom);
  const tileSize = TILE_SIZE * scale;
  const center = toTile(view.longitude, view.latitude, rasterZoom);
  return tiles.map(tile => {
    const x = tile.x + Math.round((center.x - tile.x - .5) / count) * count;
    return { ...tile, left: (x - center.x) * tileSize + size.width / 2, top: (tile.y - center.y) * tileSize + size.height / 2, scale };
  }).filter(tile => tile.left < size.width && tile.top < size.height && tile.left + tileSize > 0 && tile.top + tileSize > 0);
}
