import React, { useState } from 'react';
import { AlarmClock, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Toggle, toast } from '../ui';
import DeviceForm, { formatWeekdays } from './DeviceForm';

const pad = (number: any) => String(Number(number) || 0).padStart(2, '0');

export default function AlarmsPanel({ watchId }: { watchId: string; caps?: any }) {
  const base = `/api/watch/${encodeURIComponent(watchId)}/alarms`;
  const resource = useResource<any>((signal) => api(base, { signal }), [watchId]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState('');
  if (resource.loading && !resource.data) return <LoadingState />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const alarms = Array.isArray(resource.data?.alarms) ? resource.data.alarms : [];
  const toggle = async (item: any) => {
    if (busy) return;
    setBusy(String(item.id));
    try { await post(`${base}/${encodeURIComponent(item.id)}/toggle`); await resource.reload(); toast('闹钟状态已更新', 'success'); }
    catch (error: any) { toast(error.message || '更新失败', 'danger'); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!deleting || busy) return;
    setBusy(String(deleting.id));
    setDeleteError('');
    try { await api(`${base}/${encodeURIComponent(deleting.id)}`, { method: 'DELETE' }); setDeleting(null); await resource.reload(); toast('闹钟已删除', 'success'); }
    catch (error: any) { setDeleteError(error.message || '删除失败，请重试'); }
    finally { setBusy(null); }
  };
  return <div className="device-alarms-page stack">
    <PageHeader title="闹钟" description="为日常作息安排提醒，按星期设置重复。" actions={<>
      <Button variant="secondary" onClick={resource.reload} disabled={resource.loading}><RefreshCw size={16} />刷新</Button>
      <Button onClick={() => setAdding(true)}><Plus size={16} />添加闹钟</Button>
    </>} />
    {resource.error && <ErrorState error={resource.error} onRetry={resource.reload} />}
    <Card title="手表闹钟" action={<Badge>{alarms.length} 个</Badge>}>
      {!alarms.length ? <EmptyState title="还没有闹钟" description="为起床、学习或休息添加一条提醒。" action={<Button onClick={() => setAdding(true)}><Plus size={16} />添加闹钟</Button>} /> : <div className="device-alarm-grid">{alarms.map((item: any) => <div className="device-item device-alarm-item" key={item.id}>
        <span className="device-icon"><AlarmClock size={20} /></span>
        <div className="device-item-main"><div className="device-alarm-time">{pad(item.hours)}:{pad(item.minutes)}</div><p className="device-item-title">{item.title || '闹钟'}</p><p className="device-item-description">{formatWeekdays(item.weeks)}</p></div>
        <Toggle checked={Number(item.status) === 1} onChange={() => toggle(item)} disabled={!!busy} label={`${item.title || '闹钟'} ${pad(item.hours)}:${pad(item.minutes)}`} />
        <Button variant="ghost" size="icon" aria-label={`删除 ${item.title || '闹钟'} ${pad(item.hours)}:${pad(item.minutes)}`} disabled={!!busy} onClick={() => { setDeleteError(''); setDeleting(item); }}><Trash2 size={19} /></Button>
      </div>)}</div>}
    </Card>
    {adding && <DeviceForm title="添加闹钟" submitLabel="添加" fields={[
      { name: 'time', label: '提醒时间', type: 'time', value: '07:00', required: true },
      { name: 'title', label: '提醒名称', value: '闹钟', required: true },
      { name: 'weeks', label: '重复', type: 'weekdays', value: 127 },
    ]} onClose={() => setAdding(false)} onSubmit={async ({ time, ...values }) => { const [hours, minutes] = time.split(':').map(Number); await post(base, { ...values, hours, minutes }); await resource.reload(); }} />}
    <Modal open={!!deleting} closeable={!busy} title="删除闹钟" description={`确定删除“${deleting?.title || '闹钟'} ${pad(deleting?.hours)}:${pad(deleting?.minutes)}”吗？`} onClose={() => { if (!busy) setDeleting(null); }} footer={<>
      <Button variant="secondary" disabled={!!busy} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={!!busy} onClick={remove}>{busy ? '删除中…' : '删除闹钟'}</Button>
    </>}>{deleteError && <p role="alert" className="device-form-error">{deleteError}</p>}</Modal>
  </div>;
}
