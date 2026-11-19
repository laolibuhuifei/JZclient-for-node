import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './home-runtime-trends.css';

export type RuntimeTrendSample = {
  system?: { cpuPercent?: unknown; memPercent?: unknown };
  process?: { pid?: unknown; uptime?: unknown };
};
type TrendPoint = { at: number; cpu: number | null; memory: number | null; breakBefore?: boolean };
type TrendHistory = { points: TrendPoint[]; pid: string | null; uptime: number | null };
type Series = 'cpu' | 'memory';
type PlotPoint = { at: number; x: number; y: number };
type PlotFrame = { latestAt: number | null; segments: PlotPoint[][] };
const WINDOW_MS = 120000;
const MAX_SAMPLES = 41;
const UPDATE_DURATION_MS = 420;
const emptyHistory: TrendHistory = { points: [], pid: null, uptime: null };

function finiteNumber(value: unknown) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percentage(value: unknown) {
  const number = finiteNumber(value);
  return number == null ? null : Math.max(0, Math.min(100, number));
}

function reading(value: number | null) { return value == null ? '—' : `${Math.round(value * 10) / 10}%`; }

export function appendRuntimeSample(history: TrendHistory, sample: RuntimeTrendSample, receivedAt: number, breakBefore = false): TrendHistory {
  const rawPid = sample.process?.pid;
  const pid = (typeof rawPid === 'number' || typeof rawPid === 'string') && String(rawPid).trim() ? String(rawPid) : null;
  const uptime = finiteNumber(sample.process?.uptime);
  const restarted = (pid != null && history.pid != null && pid !== history.pid)
    || (uptime != null && history.uptime != null && uptime < history.uptime);
  const previous = restarted ? [] : history.points;
  const at = Math.max(receivedAt, (previous[previous.length - 1]?.at ?? receivedAt - 1) + 1);
  const point: TrendPoint = { at, cpu: percentage(sample.system?.cpuPercent), memory: percentage(sample.system?.memPercent), breakBefore };
  return {
    points: [...previous.filter(item => item.at >= at - WINDOW_MS), point].slice(-MAX_SAMPLES),
    pid: pid ?? (restarted ? null : history.pid),
    uptime: uptime ?? (restarted ? null : history.uptime),
  };
}

function plotSegments(points: TrendPoint[], series: Series) {
  const latestAt = points[points.length - 1]?.at ?? 0;
  const segments: PlotPoint[][] = [];
  let segment: PlotPoint[] = [];
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    const value = point[series];
    if (value == null || point.breakBefore || (index > 0 && point.at - points[index - 1].at > 10000)) {
      if (segment.length) segments.push(segment);
      segment = [];
    }
    if (value != null) segment.push({ at: point.at, x: 4 + 272 * (point.at - latestAt + WINDOW_MS) / WINDOW_MS, y: 104 - value * .96 });
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function lineCoordinates(segment: PlotPoint[]) {
  return segment.map(point => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

function TrendChart({ points, series, label, accessibleLabel }: { points: TrendPoint[]; series: Series; label: string; accessibleLabel: string }) {
  const figureRef = useRef<HTMLElement | null>(null);
  const lineRefs = useRef<(SVGPolylineElement | null)[]>([]);
  const displayedFrame = useRef<PlotFrame | null>(null);
  const settleAnimation = useRef<(() => void) | null>(null);
  const visible = useRef(true);
  const motionPreference = useRef<MediaQueryList | null>(null);
  const current = points[points.length - 1]?.[series] ?? null;
  const validSamples = points.filter(point => point[series] != null).length;
  const segments = plotSegments(points, series);

  useEffect(() => {
    const preference = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    motionPreference.current = preference;
    const stopWhenHidden = () => { if (document.hidden || preference?.matches || !visible.current) settleAnimation.current?.(); };
    preference?.addEventListener?.('change', stopWhenHidden);
    document.addEventListener('visibilitychange', stopWhenHidden);
    const observer = typeof window.IntersectionObserver === 'function' ? new window.IntersectionObserver(entries => {
      visible.current = entries.some(entry => entry.isIntersecting);
      stopWhenHidden();
    }) : null;
    if (figureRef.current) observer?.observe(figureRef.current);
    return () => {
      preference?.removeEventListener?.('change', stopWhenHidden);
      document.removeEventListener('visibilitychange', stopWhenHidden);
      observer?.disconnect();
      motionPreference.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const target: PlotFrame = { latestAt: points[points.length - 1]?.at ?? null, segments: plotSegments(points, series) };
    const previous = displayedFrame.current;
    let frameId: number | null = null;
    const paint = (frame: PlotFrame) => {
      displayedFrame.current = frame;
      frame.segments.forEach((segment, index) => lineRefs.current[index]?.setAttribute('points', lineCoordinates(segment)));
    };
    const settle = () => {
      if (frameId != null) window.cancelAnimationFrame(frameId);
      frameId = null;
      paint(target);
      if (figureRef.current) figureRef.current.dataset.animating = 'false';
    };
    settleAnimation.current = settle;
    // Interpolate only this small SVG. Readings/history stay exact and no layout
    // is measured or React state updated on animation frames.
    const shouldAnimate = previous?.latestAt != null && target.latestAt !== previous.latestAt
      && points.some(point => point.at === previous.latestAt)
      && !document.hidden && visible.current && !motionPreference.current?.matches
      && typeof window.requestAnimationFrame === 'function';
    if (shouldAnimate) {
      const previousByTime = new Map(previous.segments.flat().map(point => [point.at, point]));
      const start = target.segments.map(segment => segment.map((point, index) => {
        const existing = previousByTime.get(point.at);
        // A new endpoint grows only within its own continuous series segment.
        // A missing reading, interruption or reset can never bridge two lines.
        const preceding = index > 0 ? previousByTime.get(segment[index - 1].at) : null;
        return { ...point, x: existing?.x ?? preceding?.x ?? point.x, y: existing?.y ?? preceding?.y ?? point.y };
      }));
      const startedAt = window.performance.now();
      const draw = (now: number) => {
        const progress = Math.max(0, Math.min(1, (now - startedAt) / UPDATE_DURATION_MS));
        const eased = 1 - (1 - progress) ** 3;
        paint({ latestAt: target.latestAt, segments: target.segments.map((segment, index) => segment.map((point, pointIndex) => ({
          ...point,
          x: start[index][pointIndex].x + (point.x - start[index][pointIndex].x) * eased,
          y: start[index][pointIndex].y + (point.y - start[index][pointIndex].y) * eased,
        }))) });
        if (progress < 1) frameId = window.requestAnimationFrame(draw);
        else { frameId = null; if (figureRef.current) figureRef.current.dataset.animating = 'false'; }
      };
      paint({ latestAt: target.latestAt, segments: start });
      if (figureRef.current) figureRef.current.dataset.animating = 'true';
      frameId = window.requestAnimationFrame(draw);
    } else settle();
    return () => {
      if (frameId != null) window.cancelAnimationFrame(frameId);
      if (settleAnimation.current === settle) settleAnimation.current = null;
    };
  }, [points, series]);

  return <figure ref={figureRef} className="home-runtime-trend" data-series={series} data-valid-samples={validSamples}>
    <figcaption><h3>{label}</h3><strong className="home-runtime-trend-current">{reading(current)}</strong></figcaption>
    <div className="home-runtime-trend-plot">
      <div className="home-runtime-trend-axis" aria-hidden="true"><span>100</span><span>50</span><span>0</span></div>
      <svg viewBox="0 0 280 112" preserveAspectRatio="none" role="img" aria-label={accessibleLabel}>
        <title>{accessibleLabel}</title><desc>{`最近两分钟的实际采样，当前${current == null ? '读数未知' : reading(current)}，已有 ${validSamples} 个有效读数。缺失读数和读取中断处不连接。`}</desc>
        {[8, 56, 104].map(y => <line className="home-runtime-trend-grid" key={y} x1="4" x2="276" y1={y} y2={y} vectorEffect="non-scaling-stroke" />)}
        {segments.map((segment, index) => segment.length > 1 && <polyline key={index} ref={node => { lineRefs.current[index] = node; }} className="home-runtime-trend-line" points={lineCoordinates(segment)} vectorEffect="non-scaling-stroke" />)}
      </svg>
    </div>
    <div className="home-runtime-trend-time" aria-hidden="true"><span>2 分钟前</span><span>现在</span></div>
  </figure>;
}

export default function HomeRuntimeTrends({ sample, interrupted = false }: { sample?: RuntimeTrendSample; interrupted?: boolean }) {
  const [history, setHistory] = useState<TrendHistory>(emptyHistory);
  const lastSample = useRef<RuntimeTrendSample | undefined>(undefined);
  const interruptedSinceSample = useRef(false);
  useEffect(() => {
    if (interrupted) { interruptedSinceSample.current = true; return; }
    if (!sample || sample === lastSample.current) return;
    lastSample.current = sample;
    const receivedAt = Date.now();
    const breakBefore = interruptedSinceSample.current;
    interruptedSinceSample.current = false;
    setHistory(previous => appendRuntimeSample(previous, sample, receivedAt, breakBefore));
  }, [sample, interrupted]);
  return <div className="home-runtime-trends" data-sample-count={history.points.length}>
    <TrendChart points={history.points} series="cpu" label="系统 CPU" accessibleLabel="系统 CPU 使用率趋势" />
    <TrendChart points={history.points} series="memory" label="系统内存" accessibleLabel="系统内存占用趋势" />
    <p className="home-runtime-trends-note">{history.points.length < 2 ? '正在采集趋势' : '最近 2 分钟'}<span>每 3 秒更新</span></p>
  </div>;
}
