/** DOM client bounds use screen CSS pixels; positioned content uses zoomed layout pixels. */
export function uiScale() {
  const scale = Number(document.documentElement.style.getPropertyValue('--ui-scale'));
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function layoutViewport() {
  const scale = uiScale();
  return { width: window.innerWidth / scale, height: window.innerHeight / scale };
}

export function layoutRect(element: Element) {
  const rect = element.getBoundingClientRect();
  const scale = uiScale();
  return { left: rect.left / scale, right: rect.right / scale, top: rect.top / scale, bottom: rect.bottom / scale,
    width: rect.width / scale, height: rect.height / scale };
}
