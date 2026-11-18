import React, { useId, useState } from 'react';
import { Clock3, MapPin, Plus, RefreshCw, Shield, Trash2 } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Input, Modal, PageHeader, Skeleton, toast } from '../components/ui';
import { areaSummary, readCoordinates } from '../components/location/locationUtils';
import GuardPlacePicker, { type GuardPlace } from '../components/location/GuardPlacePicker';
import RadiusInfoHint from '../components/location/RadiusInfoHint';
import '../components/location/location.css';

const GUARD_LABELS = [
  ['allDayGuardIsOpen', '全天守护'], ['commonPlaceIsOpen', '常去地点'], ['schoolGuardIsOpen', '上学守护'],
  ['dangerAreaIsOpen', '危险区域'], ['commonAreaIsOpen', '安全区域'], ['waterAreaIsOpen', '水域提醒'],
  ['travelIsOpen', '出行守护'], ['fallIsOpen', '跌倒检测'], ['basicServiceIsOpen', '基础服务'],
];

function GuardSkeleton() {
  return <div className="guard-loading" role="status" aria-label="正在读取守护状态与区域">
    <Card><Skeleton className="location-loading-title" /><div className="guard-loading-status">{Array.from({ length: 9 }, (_, index) => <Skeleton key={index} />)}</div></Card>
    <div className="guard-area-column"><Skeleton /><Skeleton /></div>
    <span className="sr-only">正在读取守护状态与区域…</span>
  </div>;
}

export default function GuardPage() {
  const { watchId, navigate } = useApp();
  if (!watchId) return <div className="guard-page"><PageHeader title="安全区域" description="查看守护状态，管理需要留意的区域。" /><EmptyState title="还没有选择手表" description="请先选择或绑定一块手表。" action={<Button onClick={() => navigate('bind')}>绑定手表</Button>} /></div>;
  return <WatchGuard key={watchId} watchId={watchId} />;
}

function WatchGuard({ watchId }: { watchId: string }) {
  const base = `/api/watch/${encodeURIComponent(watchId)}/guard`;
  const resource = useResource((signal?: AbortSignal) => api(base, { signal }), [base]);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const data = resource.data;
  const common = Array.isArray(data?.common?.commonAreaList) ? data.common.commonAreaList : [];
  const danger = Array.isArray(data?.danger?.dangerAreaList) ? data.danger.dangerAreaList : [];

  async function removeArea() {
    if (deleting?.areaId == null || busy) return;
    setBusy(true);
    setDeleteError('');
    try {
      await api(`${base}/danger/${encodeURIComponent(String(deleting.areaId))}`, { method: 'DELETE' });
      toast('危险区域已删除', 'success');
      setDeleting(null);
      resource.reload();
    } catch (failure) { setDeleteError(failure instanceof Error ? failure.message : '删除失败，请重试。'); }
    finally { setBusy(false); }
  }

  function areaList(areas: any[], canDelete: boolean) {
    return <ul className="guard-area-list">{areas.map((area: any, index: number) => <li className="guard-area-item" key={area.areaId ?? index}>
      <span className="guard-area-icon"><MapPin size={22} strokeWidth={1.7} aria-hidden="true" /></span>
      <div className="guard-area-detail"><strong>{area.areaName || area.name || (canDelete ? '危险区域' : '常见区域')}</strong><p>{areaSummary(area)}</p><small>区域 ID · {area.areaId ?? '未知'}</small></div>
      {canDelete && <Button variant="ghost" size="icon" aria-label={`删除危险区域 ${area.areaId ?? index + 1}`} title="删除危险区域" disabled={area.areaId == null}
        onClick={() => { setDeleteError(''); setDeleting(area); }}><Trash2 size={19} aria-hidden="true" /></Button>}
    </li>)}</ul>;
  }

  return <div className="guard-page">
    <PageHeader title="安全区域" description="查看守护状态，管理需要留意的区域。" actions={<Button variant="secondary" onClick={resource.reload} disabled={resource.loading} aria-busy={resource.loading}><RefreshCw size={19} aria-hidden="true" />{resource.loading ? '刷新中…' : '刷新'}</Button>} />
    {resource.loading && !data ? <GuardSkeleton /> : resource.error && !data ? <ErrorState error={resource.error} onRetry={resource.reload} /> : data && <>
      {resource.error && <div className="location-refresh-warning" role="status"><Clock3 size={20} aria-hidden="true" /><span>守护信息刷新失败，已保留上次读取的内容。<small>{resource.error?.message || String(resource.error)}</small></span><Button variant="ghost" onClick={resource.reload} disabled={resource.loading}>重试</Button></div>}
      <div className="guard-layout">
        <Card className="guard-status-card" title="守护状态" description="手表当前启用的守护服务。" action={<Shield size={25} strokeWidth={1.6} className="muted" aria-hidden="true" />}>
          {data.status == null ? <EmptyState title="暂未获取到守护状态" description="可以刷新后重试。" /> : <div className="guard-status-list">
            {GUARD_LABELS.map(([key, label]) => <div key={key} className="guard-status-row"><span>{label}</span><Badge tone={Number(data.status[key]) === 1 ? 'success' : 'neutral'}>{data.status[key] == null ? '未获取' : Number(data.status[key]) === 1 ? '开启' : '关闭'}</Badge></div>)}
          </div>}
        </Card>
        <div className="guard-area-column">
          <Card className="guard-common-card" title="常见区域" description="查看手表记录的常见区域。" action={<Badge>{common.length} 个区域</Badge>}>
            {data.common == null ? <EmptyState title="暂未获取到常见区域" description="可以刷新后重试。" /> : !common.length ? <EmptyState title="暂无常见区域" description="手表记录的区域会显示在这里。" /> : areaList(common, false)}
          </Card>
          <Card className="guard-danger-card" title="危险区域" description="为需要留意的地点设置区域范围。" action={<Button variant="secondary" onClick={() => setAdding(true)}><Plus size={19} aria-hidden="true" />添加区域</Button>}>
            {data.danger == null ? <EmptyState title="暂未获取到危险区域" description="可以刷新后重试，或添加一个新区域。" /> : !danger.length ? <EmptyState title="还没有危险区域" description="搜索地点或在地图上选择中心，再设置区域范围。" /> : areaList(danger, true)}
          </Card>
        </div>
      </div>
    </>}
    {adding && <AddAreaDialog base={base} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); resource.reload(); }} />}
    <Modal open={deleting !== null} onClose={() => { if (!busy) setDeleting(null); }} closeable={!busy} className="guard-dialog" title="删除危险区域" description="删除后，这个区域将从手表的危险区域列表移除。"
      footer={<><Button variant="secondary" onClick={() => setDeleting(null)} disabled={busy}>取消</Button><Button variant="danger" onClick={removeArea} disabled={busy}>{busy ? '删除中…' : '确认删除'}</Button></>}>
      {deleting && <p className="location-hint">{areaSummary(deleting)}</p>}
      {deleteError && <p className="guard-form-error" role="alert">{deleteError}</p>}
    </Modal>
  </div>;
}

function AddAreaDialog({ base, onClose, onSaved }: { base: string; onClose: () => void; onSaved: () => void }) {
  const { watch } = useApp();
  const [place, setPlace] = useState<GuardPlace | null>(null);
  const [radiusInput, setRadiusInput] = useState('300');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [radiusError, setRadiusError] = useState('');
  const formId = useId();
  const radiusErrorId = useId();
  const radiusHintId = useId();
  const radiusInputId = useId();
  const selectionHintId = useId();
  const radius = Number(radiusInput);
  const validRadius = radiusInput.trim() !== '' && Number.isFinite(radius) && radius > 0;

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (saving) return;
    const coordinates = readCoordinates(place);
    if (!coordinates) { setError('请搜索并选择一个地点，或在地图上选择区域中心。'); return; }
    if (!validRadius) { setRadiusError('请输入大于 0 的半径。'); return; }
    setSaving(true);
    setError('');
    setRadiusError('');
    try {
      await post(`${base}/danger`, { ...coordinates, radius }, { timeoutMs: 60000 });
      toast('危险区域已添加', 'success');
      onSaved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : '添加失败，请重试。'); }
    finally { setSaving(false); }
  }

  return <Modal open onClose={() => { if (!saving) onClose(); }} closeable={!saving} className="guard-dialog guard-place-dialog" size="xl" title="添加危险区域" description="搜索地点或在地图上选择中心，再设置范围。"
    footer={<><Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button><Button type="submit" form={formId} loading={saving} disabled={!place || !validRadius} aria-describedby={!place ? selectionHintId : !validRadius ? radiusErrorId : undefined}>添加区域</Button></>}>
    <form id={formId} onSubmit={save} className="guard-area-form" noValidate>
      <fieldset className="guard-area-fieldset" disabled={saving}>
        <GuardPlacePicker value={place} onChange={next => { setPlace(next); setError(''); }} radius={validRadius ? radius : 0} disabled={saving} initialCenter={readCoordinates(watch?.lastLocation)} />
        {!place && <p id={selectionHintId} className="sr-only">先选择一个地点才能添加区域。</p>}
        <div className="guard-area-radius">
          <div className="field guard-area-radius-field"><div className="guard-area-radius-label"><label htmlFor={radiusInputId}>半径（米）</label><RadiusInfoHint descriptionId={radiusHintId} disabled={saving} /></div>
            <Input id={radiusInputId} className="guard-area-radius-input" type="number" inputMode="decimal" min={0} step="any" required value={radiusInput}
            aria-invalid={!!radiusError || !validRadius} aria-describedby={`${radiusHintId}${radiusError || !validRadius ? ` ${radiusErrorId}` : ''}`}
            onChange={event => { setRadiusInput(event.target.value); setRadiusError(''); setError(''); }} /></div>
        </div>
        {(radiusError || !validRadius) && <p id={radiusErrorId} className="guard-form-error" role="alert">{radiusError || '请输入大于 0 的半径。'}</p>}
      </fieldset>
      {error && <p className="guard-form-error" role="alert">{error}</p>}
    </form>
  </Modal>;
}
