import React from 'react';
import { Badge } from '../components/ui';

export function formatBytes(value: unknown) {
  const n = Number(value);
  if (value == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, n), unit = 0;
  while (v >= 1024 && unit < units.length - 1) { v /= 1024; unit++; }
  return `${v >= 100 || Number.isInteger(v) ? Math.round(v) : v.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(value: unknown) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  const seconds = Math.max(0, Math.floor(Number(value)));
  const days = Math.floor(seconds / 86400), hours = Math.floor(seconds % 86400 / 3600), minutes = Math.floor(seconds % 3600 / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  if (minutes) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
}

export function formatTime(value: unknown, short = false) {
  if (value == null || value === '') return '—';
  let n = Number(value);
  if (!Number.isFinite(n)) n = Date.parse(String(value));
  else if (n > 0 && n < 1e12) n *= 1000;
  if (!Number.isFinite(n) || n <= 0) return '—';
  const date = new Date(n);
  return short ? date.toLocaleDateString('zh-CN') : date.toLocaleString('zh-CN', { hour12: false });
}

export function percent(value: unknown) {
  return value == null || !Number.isFinite(Number(value)) ? '—' : `${Math.round(Number(value) * 10) / 10}%`;
}

export function onlineText(value: unknown) {
  return value === true ? '在线' : value === false ? '离线' : '状态未知';
}

export function OnlineBadge({ value }: { value: unknown }) {
  return <Badge tone={value === true ? 'success' : 'neutral'}>{onlineText(value)}</Badge>;
}

function batteryReading(value: unknown) {
  const number = Number(value);
  const known = value != null && value !== '' && Number.isFinite(number);
  const battery = known ? Math.max(0, Math.min(100, number)) : 0;
  return { known, battery };
}

export function BatteryRing({ value, compact = false }: { value: unknown; compact?: boolean }) {
  const { known, battery } = batteryReading(value);
  return <span className="home-battery-ring" data-low={known && battery <= 20 ? 'true' : undefined}>
    <span className="home-battery-dial" role={known ? 'meter' : 'img'} aria-label={known ? '手表剩余电量' : '手表剩余电量未知'} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={known ? battery : undefined} aria-valuetext={known ? `${battery}%` : undefined}>
      <svg viewBox="0 0 112 112" aria-hidden="true"><circle className="home-battery-track" cx="56" cy="56" r="47" /><circle className="home-battery-value" cx="56" cy="56" r="47" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - battery} /></svg>
      <strong>{known ? `${Math.round(battery)}%` : '—'}</strong>
    </span>{!compact && <span>剩余电量</span>}
  </span>;
}

export function BatteryOutline({ value }: { value: unknown }) {
  const { known, battery } = batteryReading(value);
  return <span className="home-watch-battery-outline" data-known={known} data-low={known && battery <= 20 ? 'true' : undefined} role={known ? 'meter' : 'img'} aria-label={known ? '手表剩余电量' : '手表剩余电量未知'} aria-valuemin={known ? 0 : undefined} aria-valuemax={known ? 100 : undefined} aria-valuenow={known ? battery : undefined} aria-valuetext={known ? `${battery}%` : undefined}>
    <svg aria-hidden="true"><rect className="home-watch-battery-outline-track" x="1" y="1" rx="15" pathLength="100" /><rect className="home-watch-battery-outline-value" x="1" y="1" rx="15" pathLength="100" strokeDasharray="100" strokeDashoffset={battery - 100} /></svg>
    <strong className="home-watch-battery-number">{known ? `${Math.round(battery)}%` : '—'}</strong>
  </span>;
}

export function MetricBar({ value, label }: { value: unknown; label: string }) {
  const n = Number(value);
  const valid = value != null && Number.isFinite(n);
  return <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={valid ? Math.max(0, Math.min(100, n)) : undefined}
    style={{ height: 5, width: '100%', background: 'var(--border)', borderRadius: 10, overflow: 'hidden' }}>
    <div style={{ height: '100%', width: `${valid ? Math.max(0, Math.min(100, n)) : 0}%`, background: n >= 85 ? 'var(--danger, #dc2626)' : n >= 60 ? '#c89235' : 'var(--meter-fill, var(--foreground))', borderRadius: 10, transition: 'width 500ms ease' }} />
  </div>;
}

export function DetailRows({ items }: { items: [string, React.ReactNode][] }) {
  return <dl style={{ margin: 0 }}>
    {items.map(([label, value], index) => <div key={label} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'baseline', gap: '6px 16px', padding: '12px 0', borderBottom: index === items.length - 1 ? undefined : '1px solid var(--border)' }}>
      <dt className="muted" style={{ fontSize: 13 }}>{label}</dt>
      <dd style={{ margin: 0, fontSize: 13, fontWeight: 500, overflowWrap: 'anywhere', textAlign: 'right', maxWidth: '100%' }}>{value ?? '—'}</dd>
    </div>)}
  </dl>;
}
