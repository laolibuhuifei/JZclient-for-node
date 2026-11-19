import React, { useEffect, useState } from 'react';
import { ArrowRight, MapPin, MessageCircle, RefreshCw, ShieldCheck, Unlink, Users, Watch } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Toggle, toast } from '../components/ui';
import { BatteryRing, OnlineBadge, formatTime } from './HomePageParts';
import { DataRows } from '../components/device/DeviceForm';
import '../components/device/device.css';

const GUARDS = [
  ['allDayGuardIsOpen', '全天守护'], ['commonPlaceIsOpen', '常去地点'], ['schoolGuardIsOpen', '上学守护'],
  ['dangerAreaIsOpen', '危险区域'], ['commonAreaIsOpen', '安全区域'], ['waterAreaIsOpen', '水域提醒'],
  ['travelIsOpen', '出行守护'], ['fallIsOpen', '跌倒检测'], ['basicServiceIsOpen', '基础服务'],
];

function OverviewContent({ id }: { id: string }) {
  const { watch, navigate, refreshAll } = useApp();
  const endpoint = `/api/watch/${encodeURIComponent(id)}`;
  const overview = useResource((signal: AbortSignal) => api(`${endpoint}/overview`, { signal }), [id]);
  const live = useResource((signal: AbortSignal) => api(`${endpoint}/status`, { signal }), [id], 30000);
  const automatic = useResource((signal: AbortSignal) => api(`${endpoint}/autoagree`, { signal }), [id]);
  const d: any = overview.data;
  const a = d?.account || {};
  const state: any = live.data || {};
  const status = { ...(d?.status || {}), ...state };
  const battery = live.data ? state : d?.batteryInfo || {};
  const [classMode, setClassMode] = useState(false);
  const [autoAgree, setAutoAgree] = useState(false);
  const [busy, setBusy] = useState('');
  const [confirmUnbind, setConfirmUnbind] = useState(false);
  const [operationError, setOperationError] = useState('');

  useEffect(() => { setClassMode(Number(d?.classModes?.[0]?.classSwitch) === 1); }, [d]);
  useEffect(() => { setAutoAgree(!!(automatic.data as any)?.enabled); }, [automatic.data]);

  async function toggle(kind: 'classmode' | 'autoagree', checked: boolean) {
    const previous = kind === 'classmode' ? classMode : autoAgree;
    const set = kind === 'classmode' ? setClassMode : setAutoAgree;
    set(checked); setBusy(kind); setOperationError('');
    try {
      await post(`${endpoint}/${kind === 'classmode' ? 'settings/classmode' : 'autoagree'}`, kind === 'classmode' ? { disabled: checked } : { enabled: checked });
      toast(`${checked ? '已开启' : '已关闭'}${kind === 'classmode' ? '上课禁用' : '自动同意好友'}`);
    } catch (error: any) { set(previous); setOperationError(error.message); toast(error.message, 'danger'); }
    finally { setBusy(''); }
  }

  async function unbind() {
    if (!watch?.relationId) { setOperationError('缺少关系 ID，请刷新手表列表后重试。'); return; }
    setBusy('unbind'); setOperationError('');
    try {
      await post(`${endpoint}/unbind`, { relationId: watch.relationId });
      setConfirmUnbind(false);
      toast('手表已解绑');
      await refreshAll();
      navigate('home');
    } catch (error: any) { setOperationError(error.message); toast(error.message, 'danger'); }
    finally { setBusy(''); }
  }

  async function refresh() {
    setBusy('refresh');
    try { await Promise.all([overview.reload(), live.reload(), automatic.reload()]); }
    finally { setBusy(''); }
  }

  const online = live.data ? state.onlineStatus : d?.onlineStatus;
  const batteryAt = battery.batteryAt ? `${battery.batteryTimeKind === 'received' ? '接收于 ' : ''}${formatTime(battery.batteryAt)}` : '—';
  return <div className="overview-page stack">
    <PageHeader title="手表概览" description="设备信息、家庭成员与常用守护设置。" actions={<Button variant="secondary" onClick={refresh} disabled={!!busy}><RefreshCw size={16} />刷新</Button>} />
    {overview.loading && !d && <LoadingState />}
    {overview.error && !d && <ErrorState error={overview.error} onRetry={overview.reload} />}
    {d && <>
      <Card className="overview-device-card">
        <div className="overview-device-identity">
          <div className="overview-avatar">
            {d.avatarUrl ? <img src={d.avatarUrl} alt={`${a.name || '手表'}的头像`} /> : <Watch size={36} strokeWidth={1.6} aria-hidden="true" />}
          </div>
          <div className="overview-device-name">
            <div className="overview-device-name-row"><h2>{a.name || watch?.name || '未命名手表'}</h2><OnlineBadge value={online} /></div>
            <p>{a.model || '型号未知'}<span aria-hidden="true"> · </span>{a.number || '未设置号码'}</p>
            <span className="overview-firmware">固件 {a.firmware || '—'}</span>
          </div>
          <BatteryRing value={battery.battery} />
        </div>
        <div className="overview-device-actions"><span className="overview-device-id">设备 ID <span className="mono">{id}</span></span><div className="action-row">
          <Button variant="secondary" onClick={() => navigate('location')}><MapPin size={19} aria-hidden="true" />查看位置</Button>
          <Button variant="secondary" onClick={() => navigate('chat')}><MessageCircle size={19} aria-hidden="true" />打开聊天</Button>
          <Button variant="ghost" onClick={() => navigate('profile')}>编辑资料<ArrowRight size={18} aria-hidden="true" /></Button>
        </div></div>
      </Card>

      <div className="overview-main-layout">
        <Card className="overview-detail-card" title="设备详情">
          <DataRows items={[
            { label: 'watchId', value: <span className="mono">{id}</span> }, { label: 'IMEI', value: <span className="mono">{a.imei || '—'}</span> }, { label: '在线状态', value: <OnlineBadge value={online} /> },
            { label: '电量来源', value: battery.batterySource === 'api' ? '接口' : battery.batterySource === 'push' ? 'IM 推送' : '—' }, { label: '电量时间', value: batteryAt },
            ...(status.lastSeenAt ? [{ label: '最近收到通知', value: <span>{formatTime(status.lastSeenAt)}<small className="device-data-note">接收时间，不代表在线</small></span> }] : []),
            ...(status.lastLat != null ? [{ label: '推送位置', value: <span>{status.lastAddress || `${status.lastLat}, ${status.lastLng}`}<small className="device-data-note">{formatTime(status.lastLocAt)}</small></span> }] : []),
          ]} />
          {live.error && <p className="device-form-error" role="status">最新状态读取失败，已保留上次的设备信息。</p>}
        </Card>
        <div className="stack overview-control-cards">
          <Card title="上课禁用" description="开启后，手表在设定时段只能联系管理员。">
            <Toggle label="启用上课禁用" checked={classMode} disabled={!!busy} onChange={checked => toggle('classmode', checked)} />
            <div className="device-card-actions"><Button variant="ghost" onClick={() => navigate('settings')}>管理时段<ArrowRight size={18} /></Button></div>
          </Card>
          <Card title="自动同意好友" description="通过 IM 长连接，自动同意这块手表收到的好友申请。">
            {automatic.error ? <ErrorState error={automatic.error} onRetry={automatic.reload} /> : <Toggle label={automatic.loading ? '正在读取设置' : '自动同意好友申请'} checked={autoAgree} disabled={!!busy || automatic.loading} onChange={checked => toggle('autoagree', checked)} />}
          </Card>
        </div>
      </div>

      {operationError && !confirmUnbind && <div role="alert"><ErrorState error={operationError} /></div>}
      <div className="overview-main-layout">
        <Card title="守护状态" description="当前手表的守护服务与提醒。" action={<Button variant="ghost" onClick={() => navigate('guard')}>管理<ArrowRight size={18} /></Button>}>
          <div className="overview-guard-list">{GUARDS.map(([key, label]) => <div key={key}><span>{label}</span><Badge tone={Number(d.guard?.[key]) === 1 ? 'success' : 'neutral'}>{d.guard?.[key] == null ? '未获取' : Number(d.guard[key]) === 1 ? '开启' : '关闭'}</Badge></div>)}</div>
        </Card>
        <Card title="家庭成员" description={`共 ${(d.members || []).length} 位家庭成员`}>
          {(d.members || []).length ? <div className="overview-family-list" role="list">{d.members.map((member: any, index: number) => {
            const isAdmin = Number(member.authorize) === 1 || String(member.role || '').includes('admin');
            return <div className="device-item" role="listitem" key={member.mobileId || index}>
              <span className="device-icon" aria-hidden="true">{isAdmin ? <ShieldCheck size={22} /> : <Users size={22} />}</span>
              <div className="device-item-main"><strong className="device-item-title">{member.salutation || '成员'}</strong><p className="device-item-description">{member.mobileNumber || member.mobileId || '—'}</p></div><Badge>{isAdmin ? '管理员' : '成员'}</Badge>
            </div>;
          })}</div> : <EmptyState title="暂无家庭成员" />}
        </Card>
      </div>
      <Card className="device-danger-card" title="解绑手表" description="将这块手表从当前家长账号移除。" action={
        <Button variant="danger" onClick={() => { setOperationError(''); setConfirmUnbind(true); }} disabled={!!busy}><Unlink size={18} />解绑手表</Button>
      }>
      </Card>
    </>}
    <Modal open={confirmUnbind} closeable={busy !== 'unbind'} onClose={() => { if (busy !== 'unbind') setConfirmUnbind(false); }} title="确认解绑手表？" description={`「${a.name || watch?.name || id}」将从当前账号移除。`} footer={<><Button variant="secondary" disabled={busy === 'unbind'} onClick={() => setConfirmUnbind(false)}>取消</Button><Button variant="danger" loading={busy === 'unbind'} onClick={unbind}>{busy === 'unbind' ? '正在解绑…' : '确认解绑'}</Button></>}>
      <p className="muted">请确认你正在操作的手表。解绑成功后，如需继续管理，需要重新绑定。</p>
      {operationError && <ErrorState error={operationError} />}
    </Modal>
  </div>;
}

export default function OverviewPage() {
  const { watchId, account, navigate } = useApp();
  if (!watchId) return <div className="stack"><PageHeader title="手表概览" /><EmptyState title={account?.loggedIn ? '请选择或绑定手表' : '请先登录家长账号'} action={<Button onClick={() => navigate(account?.loggedIn ? 'bind' : 'account')}>{account?.loggedIn ? '绑定手表' : '去登录'}</Button>} /></div>;
  return <OverviewContent key={watchId} id={String(watchId)} />;
}
