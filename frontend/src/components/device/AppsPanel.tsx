import React, { useState } from 'react';
import { AppWindow, Clock3, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, Toggle, toast } from '../ui';
import DeviceForm, { DataRows, DeviceField } from './DeviceForm';

const storeFields = [
  ['autoUpdateSwitch', '应用自更新'], ['watchAllowSwitch', '手表允许安装'], ['allowDownloadSwitch', '允许下载'],
  ['watchAuthoriseSwitch', '安装授权'], ['downChannelSwitch', '下载通道'], ['personalRecommend', '个性化推荐'],
];
const triOptions = [{ value: '2', label: '自动 / 默认' }, { value: '1', label: '开启' }, { value: '0', label: '关闭' }];
const switchOptions = [{ value: '1', label: '开启' }, { value: '0', label: '关闭' }];
const tri = (value: any) => value == null ? '—' : Number(value) === 0 ? '关闭' : Number(value) === 1 ? '开启' : Number(value) === 2 ? '自动' : String(value);

export default function AppsPanel({ watchId }: { watchId: string; caps?: any }) {
  const base = `/api/watch/${encodeURIComponent(watchId)}`;
  const resource = useResource<any>((signal) => api(`${base}/apps`, { signal }), [watchId]);
  const [editing, setEditing] = useState<'store' | 'duration' | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  if (resource.loading && !resource.data) return <LoadingState />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const data = resource.data || {};
  const store = data.storeSwitch || {};
  const apps = Array.isArray(data.apps) ? data.apps : [];
  const levels = Array.isArray(data.levels) ? data.levels : [];
  const duration = data.duration || {};
  const report = data.report || {};
  const total = Math.round(Number(duration.totalDuration) || 0);
  const used = Math.round(Number(data.todayUse?.alreadyDuration) || 0);
  const fields: DeviceField[] = editing === 'store' ? [
    ...storeFields.slice(0, 5).map(([name, label]) => ({ name, label, type: 'select' as const, value: String(store[name] ?? 0), options: triOptions })),
    { name: 'userAppLevel', label: '应用等级', type: 'select', value: String(store.userAppLevel ?? ''), options: levels.length ? levels.map((level: any) => ({ value: String(level.appLevel), label: `${level.name}（等级 ${level.appLevel}）` })) : [{ value: String(store.userAppLevel ?? ''), label: store.userAppLevel == null ? '暂无等级选项' : `当前等级 ${store.userAppLevel}` }] },
    { name: 'personalRecommend', label: '个性化推荐', type: 'select', value: String(store.personalRecommend ?? 0), options: triOptions },
  ] : [
    { name: 'isOpen', label: '时长管控', type: 'select', value: Number(duration.isOpen) === 1 ? '1' : '0', options: switchOptions },
    { name: 'totalDuration', label: '每日可用时长（分钟）', type: 'number', value: total, min: 0, required: true },
    { name: 'remindSwitch', label: '剩余时长提醒', type: 'select', value: Number(duration.remindSwitch) === 1 ? '1' : '0', options: switchOptions },
    { name: 'remindDuration', label: '剩余多少分钟时提醒', type: 'number', value: duration.remindDuration ?? 10, min: 0, required: true },
  ];
  const changeReport = async (enabled: boolean) => {
    if (reportBusy) return;
    setReportBusy(true);
    try { await post(`${base}/appstore/report`, { reportSwitch: enabled ? 1 : 0, nickname: report.nickname || '' }); toast('周报设置已更新', 'success'); await resource.reload(); }
    catch (error: any) { toast(error.message || '更新失败', 'danger'); }
    finally { setReportBusy(false); }
  };
  return <div className="device-apps-page stack">
    <PageHeader title="应用管理" description="管理应用商店权限、使用时长与每周报告。" actions={<Button variant="secondary" onClick={resource.reload} disabled={resource.loading}><RefreshCw size={16} />刷新</Button>} />
    {resource.error && <ErrorState error={resource.error} onRetry={resource.reload} />}
    <div className="device-app-controls">
      <Card title="应用商店" action={<Button variant="ghost" onClick={() => setEditing('store')}><SlidersHorizontal size={16} />设置</Button>}>
        <DataRows items={[
          ...storeFields.map(([name, label]) => ({ label, value: tri(store[name]) })),
          { label: '应用等级', value: levels.find((level: any) => String(level.appLevel) === String(store.userAppLevel))?.name || store.userAppLevel },
        ]} />
      </Card>
      <div className="stack">
        <Card title="使用时长" action={<Badge tone={Number(duration.isOpen) === 1 ? 'success' : 'neutral'}>{Number(duration.isOpen) === 1 ? '管控已开启' : '管控已关闭'}</Badge>}>
          <div className="device-metric">{used}<small>/ {total} 分钟</small></div>
          <div className="device-meter" role="progressbar" aria-label="今日已用时长" aria-valuemin={0} aria-valuemax={Math.max(total, used)} aria-valuenow={used}><span style={{ width: `${total > 0 ? Math.min(100, used / total * 100) : 0}%` }} /></div>
          <p className="muted">今日已用 {used} 分钟{Number(duration.remindSwitch) === 1 ? `，剩余 ${duration.remindDuration ?? '—'} 分钟时提醒` : '，剩余时长提醒已关闭'}。</p>
          <Button variant="secondary" onClick={() => setEditing('duration')}><Clock3 size={16} />修改时长设置</Button>
        </Card>
        <Card title="应用使用报告" description="开启后接收每周应用使用报告。"><Toggle label="周报推送" checked={Number(report.reportSwitch) === 1} onChange={changeReport} disabled={reportBusy} /></Card>
      </div>
    </div>
    <Card title="已安装应用" action={<Badge>{apps.length} 个</Badge>}>
      {!apps.length ? <EmptyState title="暂无应用" description="手表上的应用会在这里显示。" /> : <div className="device-app-list" role="list">{apps.map((item: any, index: number) => <div className="device-item device-app-item" role="listitem" key={item.packageName || index}>
        <span className="device-icon">{item.icon && /^(https?:|\/)/i.test(String(item.icon)) ? <img src={item.icon} alt="" loading="lazy" /> : <AppWindow size={20} />}</span>
        <div className="device-item-main"><p className="device-item-title">{item.name || item.packageName || '未命名应用'}</p><p className="device-item-description">v{item.versionName || item.versionCode || '—'}{item.size ? ` · ${(Number(item.size) / 1048576).toFixed(1)} MB` : ''}</p></div>
        <Badge>{item.status == null ? '状态未知' : `状态 ${item.status}`}</Badge>
      </div>)}</div>}
    </Card>
    {editing && <DeviceForm key={editing} title={editing === 'store' ? '应用商店设置' : '使用时长设置'} fields={fields} onClose={() => setEditing(null)} onSubmit={async values => { await post(`${base}/appstore/${editing}`, values); await resource.reload(); }} />}
  </div>;
}
