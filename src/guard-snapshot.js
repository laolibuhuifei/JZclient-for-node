'use strict';

const { Canvas } = require('./canvas');
const image = require('./image');
const { validateDangerArea } = require('./place-search');

const TILE_SIZE = 256;
const WIDTH = 512;
const HEIGHT = 320;
const EARTH_CIRCUMFERENCE = 40075016.686;

// The area picture is generated from the submitted center/radius, independently
// of where the user last panned the editor. Only the existing AMap tile service
// is contacted; no client-supplied image URL is fetched.
async function renderDangerAreaSnapshot(value, options = {}) {
  const { latitude, longitude, radius } = validateDangerArea(value);
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const cos = Math.cos(lat * Math.PI / 180);
  const zoom = Math.max(3, Math.min(19, Math.floor(Math.log2(110 * EARTH_CIRCUMFERENCE * cos / (radius * TILE_SIZE)))));
  const count = 2 ** zoom;
  const radians = lat * Math.PI / 180;
  const cx = (longitude + 180) / 360 * count * TILE_SIZE;
  const cy = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2 * count * TILE_SIZE;
  const canvas = new Canvas(WIDTH, HEIGHT, '#eef0f5');
  const tiles = [];
  for (let x = Math.floor((cx - WIDTH / 2) / TILE_SIZE); x <= Math.floor((cx + WIDTH / 2) / TILE_SIZE); x++) {
    for (let y = Math.floor((cy - HEIGHT / 2) / TILE_SIZE); y <= Math.floor((cy + HEIGHT / 2) / TILE_SIZE); y++) {
      if (y < 0 || y >= count) continue;
      const wrappedX = ((x % count) + count) % count;
      const server = (wrappedX + y) % 4 + 1;
      tiles.push({
        url: `https://webrd0${server}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=${wrappedX}&y=${y}&z=${zoom}`,
        left: x * TILE_SIZE - cx + WIDTH / 2,
        top: y * TILE_SIZE - cy + HEIGHT / 2,
      });
    }
  }
  const loadTile = options.loadTile || (async url => image.decode(await image.fetchBuf(url, { timeout: 12000, maxBytes: 1024 * 1024 })));
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(3, tiles.length) }, async () => {
    while (!failure && next < tiles.length) {
      const tile = tiles[next++];
      try {
        const decoded = await loadTile(tile.url);
        if (!decoded || decoded.width !== TILE_SIZE || decoded.height !== TILE_SIZE || decoded.rgba?.length !== TILE_SIZE * TILE_SIZE * 4) {
          throw new Error('Invalid map tile');
        }
        canvas.drawImage(decoded, tile.left, tile.top, TILE_SIZE, TILE_SIZE);
      } catch (error) { failure = error; }
    }
  }));
  if (failure) throw new Error('区域地图截图生成失败，请稍后重试。');

  const pixels = radius * TILE_SIZE * count / (EARTH_CIRCUMFERENCE * cos);
  canvas.circle(WIDTH / 2, HEIGHT / 2, pixels, '#515d9833');
  // Draw the outline over the real map without replacing its interior pixels.
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const distance = Math.hypot(x + .5 - WIDTH / 2, y + .5 - HEIGHT / 2);
      const alpha = Math.max(0, Math.min(1, 2 - Math.abs(distance - pixels)));
      if (alpha) canvas._blend(x, y, [81, 93, 152, 255], alpha);
    }
  }
  canvas.circle(WIDTH / 2, HEIGHT / 2, 8, '#ffffff');
  canvas.circle(WIDTH / 2, HEIGHT / 2, 5, '#515d98');
  return canvas.toPNG();
}

module.exports = { renderDangerAreaSnapshot };
