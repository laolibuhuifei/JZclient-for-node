import React from 'react';
import { Activity, Heart, Moon, RefreshCw, Thermometer } from 'lucide-react';
import { api } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '../ui';
import { DataRows } from './DeviceForm';
import './device-data-panels.css';

function time(value: any) {
  if (value == null || value === '') return '时间未知';
  const number = Number(value);
  const date = new Date(Number.isFinite(number) && number ? number < 1e12 ? number * 1000 : number : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

function stripHtml(value: any) { return String(value || '').replace(/<[^>]+>/g, '').trim(); }

function sportReading(item: any) {
  const label = String(item.name || item.title || `运动类型 ${item.sportType ?? '—'}`);
  const rawValue = item.steps ?? item.step ?? item.value;
  const value = typeof rawValue === 'number' || typeof rawValue === 'string' ? rawValue : null;
  if (value != null) return { label, value, unit: item.unit || (item.steps != null || item.step != null ? '步' : ''), detail: [item.cumulativeTime != null ? `${Math.round(Number(item.cumulativeTime) / 60)} 分钟` : '', item.cumulativeCalorie != null ? `${item.cumulativeCalorie} 千卡` : ''].filter(Boolean).join(' · ') };
  return { label, value: item.cumulativeTime != null ? Math.round(Number(item.cumulativeTime) / 60) : '—', unit: item.cumulativeTime != null ? '分钟' : '', detail: item.cumulativeCalorie != null ? `${item.cumulativeCalorie} 千卡` : '热量未知' };
}

function measurementTime(item: any, heart = false) {
  return time((heart ? item.heartRateTime : item.measureTime) ?? item.time ?? item.createTime ?? item.timestamp);
}

export default function HealthPanel({ watchId }: { watchId: string; caps?: any }) {
  const resource = useResource<any>((signal) => api(`/api/watch/${encodeURIComponent(watchId)}/health`, { signal }), [watchId]);
  if (resource.loading && !resource.data) return <LoadingState />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const data = resource.data || {};
  const summary = (Array.isArray(data.home?.healthHomeSummaryVos) ? data.home.healthHomeSummaryVos : []).map((item: any) => stripHtml(item.textV2 || item.text)).filter(Boolean);
  const sport = Array.isArray(data.sport) ? data.sport : [];
  const temperatures: any[] = Array.isArray(data.temperature?.temperatureVoList) ? data.temperature.temperatureVoList : [];
  const hearts: any[] = Array.isArray(data.heartRate?.heartRateRecordVoList) ? data.heartRate.heartRateRecordVoList : [];
  return <div className="stack health-page">
    <PageHeader title="健康数据" description="查看手表上报的运动、睡眠与健康记录。" actions={<Button variant="secondary" onClick={resource.reload} disabled={resource.loading}><RefreshCw size={16} />刷新</Button>} />
    {resource.error && <ErrorState error={resource.error} onRetry={resource.reload} />}
    <div className="health-layout">
      <Card className="health-summary-card" title={<span className="device-data-card-title"><Activity size={23} aria-hidden="true" />健康摘要</span>} action={<Badge>{data.date || '今天'}</Badge>}>
        {summary.length ? <div className="device-health-summary">{summary.map((text: string, index: number) => <p key={index}>{text}</p>)}</div> : <EmptyState title="暂无健康摘要" description="手表上报数据后会显示在这里。" />}
      </Card>
      <Card className="health-sport-card" title="运动数据" action={<span className="device-data-symbol" aria-hidden="true"><Activity size={23} /></span>}>
        {sport.length ? <div className="health-sport-readings">{sport.map((item: any, index: number) => {
          const reading = sportReading(item);
          return <div className="health-sport-reading" key={`${item.sportType ?? item.name ?? index}-${index}`}><span>{reading.label}</span><strong>{reading.value}<small>{reading.unit}</small></strong>{reading.detail && <p>{reading.detail}</p>}</div>;
        })}</div> : <EmptyState title="暂无运动记录" />}
      </Card>
      <Card className="health-sleep-card" title="睡眠" action={<span className="device-data-symbol" aria-hidden="true"><Moon size={23} /></span>}>
        {data.sleep?.topContent ? <p className="health-sleep-summary">{data.sleep.topContent}</p> : <EmptyState title="暂无睡眠数据" />}
      </Card>
      <Card className="health-record-card" title="体温记录" action={<span className="device-data-symbol" aria-hidden="true"><Thermometer size={23} /></span>} description={temperatures.length ? `${temperatures.length} 条记录，显示前 20 条` : undefined}>
        {temperatures.length ? <div className="device-record-list health-records"><DataRows items={temperatures.slice(0, 20).map((item: any) => ({ label: measurementTime(item), value: <span className="health-measurement">{item.temperature ?? item.temp ?? item.value ?? '—'}<small>°C</small></span> }))} /></div> : <EmptyState title="今日暂无体温记录" />}
        {data.temperature?.explainText && <p className="health-record-note">{String(data.temperature.explainText).split('\n')[0]}</p>}
      </Card>
      <Card className="health-record-card" title="心率记录" action={<span className="device-data-symbol" aria-hidden="true"><Heart size={23} /></span>} description={hearts.length ? `${hearts.length} 条记录，显示最近 50 条` : undefined}>
        {hearts.length ? <div className="device-record-list health-records"><DataRows items={hearts.slice(-50).reverse().map((item: any) => ({ label: measurementTime(item, true), value: <span className="health-measurement">{item.heartRate ?? item.avgHeartRate ?? item.value ?? '—'}<small>次/分</small></span> }))} /></div> : <EmptyState title="今日暂无心率记录" />}
      </Card>
    </div>
  </div>;
}
