'use strict';

const { validateDangerArea } = require('./place-search');

const EARTH_RADIUS = 6378137;
const BOUNDARY_POINTS = 24;
const RADIANS = Math.PI / 180;

// The platform requires 3–30 polygon points; the editor selects a circle.
// Keep the existing API coordinate convention: x = latitude, y = longitude.
function buildDangerAreaDetail(value) {
  const { latitude, longitude, radius } = validateDangerArea(value);
  const lat = latitude * RADIANS;
  const lng = longitude * RADIANS;
  const cosLat = Math.cos(lat);
  const sinLat = Math.sin(lat);
  const cosLng = Math.cos(lng);
  const sinLng = Math.sin(lng);
  const distance = radius / EARTH_RADIUS;
  const cosDistance = Math.cos(distance);
  const sinDistance = Math.sin(distance);

  // A local north/east frame stays stable at the poles and across the dateline.
  const points = Array.from({ length: BOUNDARY_POINTS }, (_, index) => {
    const bearing = index * 2 * Math.PI / BOUNDARY_POINTS;
    const north = Math.cos(bearing) * sinDistance;
    const east = Math.sin(bearing) * sinDistance;
    const px = cosDistance * cosLat * cosLng - north * sinLat * cosLng - east * sinLng;
    const py = cosDistance * cosLat * sinLng - north * sinLat * sinLng + east * cosLng;
    const pz = cosDistance * sinLat + north * cosLat;
    return {
      x: Math.atan2(pz, Math.hypot(px, py)) / RADIANS,
      y: Math.atan2(py, px) / RADIANS,
    };
  });

  if (points.length < 3 || points.length > 30) {
    throw new Error('区域边界点数量必须在 3～30 个之间。');
  }
  if (new Set(points.map(point => `${point.x},${point.y}`)).size < 3) {
    throw new Error('区域半径过小或无效，无法生成至少三个边界点。');
  }
  return points;
}

module.exports = { buildDangerAreaDetail };
