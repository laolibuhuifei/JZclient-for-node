import React, { useState } from 'react';
import { Camera, RefreshCw, Search, Wifi } from 'lucide-react';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Button, EmptyState, ErrorState, Field, Input, LoadingState, Modal, Textarea, toast } from '../ui';
import { formatLocationTime, localDate, photoUrl } from './locationUtils';

export function TrackDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const [date, setDate] = useState(localDate);
  const [query, setQuery] = useState<{ date: string; serial: number } | null>(null);
  const result = useResource(async (signal?: AbortSignal) => query
    ? api(`${base}/track?date=${encodeURIComponent(query.date)}`, { signal }) : null, [base, query]);
  const points = Array.isArray(result.data?.points) ? result.data.points : [];

  return <Modal open onClose={onClose} className="location-dialog" title="历史轨迹" description="按日期查看手表上报的位置记录。" size="lg"
    footer={<Button variant="secondary" onClick={onClose}>关闭</Button>}>
    <form className="location-track-form" onSubmit={event => {
      event.preventDefault();
      setQuery({ date, serial: Date.now() });
    }}>
      <Field label="查询日期"><Input type="date" required value={date} max={localDate()} onChange={event => setDate(event.target.value)} /></Field>
      <Button type="submit" disabled={!date || result.loading} aria-busy={result.loading}><Search size={19} aria-hidden="true" />{result.loading ? '查询中…' : '查询轨迹'}</Button>
    </form>
    {query && result.loading ? <LoadingState /> : result.error ? <ErrorState error={result.error} onRetry={result.reload} />
      : query && !points.length ? <EmptyState title="这一天没有轨迹" description="手表上报位置后，会在对应日期留下记录。" />
        : query ? <>
          <p className="location-track-result-count">{query.date} · 共 {points.length} 条记录</p>
          <ol className="location-track-list">{points.map((point: any, index: number) => <li key={`${point.id || point.locationTime || 'point'}-${index}`} className="location-track-point">
            <span className="location-track-index">{index + 1}</span>
            <div><strong>{[point.address, point.poi || point.originPoi, point.pointText].filter(Boolean).join(' · ') || '暂无地址描述'}</strong>
              <time>{formatLocationTime(point.locationTime)}</time></div>
          </li>)}</ol>
        </> : <EmptyState title="选择一天，查看走过的地方" description="选择日期后点击「查询轨迹」。" />}
  </Modal>;
}

export function PhotosPanel({ base }: { base: string }) {
  const resource = useResource((signal?: AbortSignal) => api(`${base}/lost/photos`, { signal }), [base]);
  const photos = Array.isArray(resource.data?.photos) ? resource.data.photos : [];
  return <section className="location-lost-panel" aria-label="手表附近照片">
    <div className="location-panel-heading"><h2>手表附近照片</h2><Button variant="ghost" size="icon" disabled={resource.loading} onClick={resource.reload} aria-label="刷新附近照片"><RefreshCw size={19} aria-hidden="true" /></Button></div>
    {resource.loading ? <LoadingState /> : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} />
      : !photos.length ? <EmptyState title="暂无照片" description="开启丢表模式后，手表会拍摄照片；亮屏时也会自动抓拍。" />
        : <div className="location-photos">{photos.map((photo: any, index: number) => {
          const url = photoUrl(photo.url);
          const metadata = [photo.createTime ? formatLocationTime(photo.createTime) : '', photo.location].filter(Boolean).join(' · ');
          return <a key={photo.id || `${url}-${index}`} className="location-photo" href={url || undefined} target="_blank" rel="noopener noreferrer">
            <figure>{url ? <img src={url} loading="lazy" alt={`手表附近照片 ${index + 1}`} /> : <Camera size={32} style={{ margin: 24 }} />}
              <figcaption>{metadata || '手表附近'}</figcaption></figure>
          </a>;
        })}</div>}
  </section>;
}

export function WifiPanel({ base }: { base: string }) {
  const resource = useResource((signal?: AbortSignal) => api(`${base}/lost/wifi`, { signal }), [base]);
  const wifi = Array.isArray(resource.data?.wifi) ? resource.data.wifi : [];
  const metadata = resource.data?.meta;
  return <section className="location-lost-panel" aria-label="手表附近 WiFi">
    <div className="location-panel-heading"><h2>手表附近 WiFi</h2><Button variant="ghost" size="icon" disabled={resource.loading} onClick={resource.reload} aria-label="刷新附近 WiFi"><RefreshCw size={19} aria-hidden="true" /></Button></div>
    {resource.loading ? <LoadingState /> : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} />
      : !wifi.length ? <>
        <EmptyState title="暂未获取到附近 WiFi" description="附近 WiFi 由手表自行扫描上报，刷新只会读取最近的上报结果。" />
        {metadata?.reportTime && <p className="location-hint">最近上报：{formatLocationTime(metadata.reportTime)} · 扫描到 {metadata.wifiCount ?? 0} 个热点</p>}
        <p className="location-hint">请确认手表 WiFi 已开启，必要时重新开关丢表模式后再刷新。</p>
      </> : <div className="location-wifi-list">{wifi.map((network: any, index: number) => <div key={`${network.mac || network.name}-${index}`} className="location-wifi-item">
        <Wifi size={22} strokeWidth={1.7} aria-hidden="true" /><div><strong>{network.name || '未知 WiFi'}</strong><span>信号 {network.signal ?? '未知'}{network.mac ? ` · ${network.mac}` : ''}</span></div>
      </div>)}</div>}
  </section>;
}

export function MessageDialog({ base, onClose }: { base: string; onClose: () => void }) {
  const resource = useResource((signal?: AbortSignal) => api(`${base}/lost/message`, { signal }), [base]);
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const message = draft ?? (resource.data?.message || '你好，这个手表是我的，请联系我，谢谢！');

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!String(message).trim()) { setError('请输入留言内容。'); return; }
    setSaving(true);
    setError('');
    try {
      await post(`${base}/lost/message`, { message: String(message).trim() });
      toast('留言已保存', 'success');
      onClose();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '保存留言失败，请重试。'); }
    finally { setSaving(false); }
  }

  return <Modal open onClose={() => { if (!saving) onClose(); }} closeable={!saving} className="location-dialog" title="留言给拾到者" description="留言会显示在丢表模式下的手表上，可填写联系信息。"
    footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button><Button type="submit" form="lost-message-form" disabled={saving || resource.loading || !!resource.error}>{saving ? '保存中…' : '保存留言'}</Button></>}>
    {resource.loading ? <LoadingState /> : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} /> : <form id="lost-message-form" onSubmit={save} className="stack">
      <Field label="留言内容" hint={`${String(message).length} / 500 字`}><Textarea autoFocus required rows={5} maxLength={500} value={message} onChange={event => setDraft(event.target.value)} /></Field>
      {error && <p className="guard-form-error" role="alert">{error}</p>}
    </form>}
  </Modal>;
}
