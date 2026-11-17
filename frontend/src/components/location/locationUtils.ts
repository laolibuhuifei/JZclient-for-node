export function formatLocationTime(value: unknown) {
  if (value == null || value === '') return '时间未知';
  const number = Number(value);
  const date = Number.isFinite(number)
    ? new Date(number < 1e12 ? number * 1000 : number)
    : new Date(String(value));
  if (!Number.isFinite(date.getTime()) || number === 0) return '时间未知';
  return date.toLocaleString('zh-CN', { hour12: false });
}

export function localDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function readCoordinates(location: any) {
  const rawLatitude = location?.latitude ?? location?.baiduLatitude;
  const rawLongitude = location?.longitude ?? location?.baiduLongitude;
  if (rawLatitude == null || rawLongitude == null || rawLatitude === '' || rawLongitude === '') return null;
  const latitude = Number(rawLatitude);
  const longitude = Number(rawLongitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

export function areaSummary(area: any) {
  const points = Array.isArray(area?.areaDetail) ? area.areaDetail : [];
  if (!points.length) {
    if (area?.x != null && area?.y != null && Number(area.radius) > 0) {
      return `中心 ${area.x}, ${area.y} · 半径 ${area.radius} 米`;
    }
    return '暂无范围数据';
  }
  if (points.length === 1 && Number(points[0]?.r) > 0) {
    return `中心 ${points[0].x}, ${points[0].y} · 半径 ${points[0].r} 米`;
  }
  return `多边形 · ${points.length} 个点`;
}

export function photoUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, window.location.origin);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch { return ''; }
}
