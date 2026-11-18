import React, { useEffect, useState } from 'react';
import { ArrowUpRight, Bell, Bot, Cable, Image, Link2, Radio, RefreshCw, ScrollText, Settings2, Shield, UserRound, Watch } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, Tabs, Toggle, toast } from '../components/ui';
import OneBotPanel from '../components/integrations/OneBotPanel';
import ExternalApiPanel from '../components/integrations/ExternalApiPanel';
import BiliPanel from '../components/integrations/BiliPanel';
import { AppearancePanel, LinksPanel } from '../components/integrations/PreferencesPanels';
import { ConfirmAction, CopyValue, StatusRow, timeLabel } from '../components/integrations/shared';
import '../components/integrations/integrations.css';

const SECTIONS = [
  { value: 'overview', label: '我的概况', icon: UserRound },
  { value: 'onebot', label: 'OneBot', icon: Cable },
  { value: 'api', label: '对外 API', icon: Shield },
  { value: 'bili', label: 'B 站点播', icon: Radio },
  { value: 'links', label: '链接库', icon: Link2 },
  { value: 'appearance', label: '外观', icon: Image },
];
export default function IntegrationsPage() {
  const { params, watch } = useApp();
  const [section, setSection] = useState(() => params?.panel === 'plugins' || params?.section === 'my' ? 'overview' : SECTIONS.some((entry) => entry.value === params?.section) ? params.section : 'overview');
  useEffect(() => {
    if (params?.panel === 'plugins') { window.location.replace('#/plugins'); return; }
    if (params?.section === 'my') setSection('overview');
    else if (SECTIONS.some((entry) => entry.value === params?.section)) setSection(params.section);
  }, [params]);
  if (params?.panel === 'plugins') return null;
  return <div className="stack integrations-page">
    <PageHeader title="我的" description="账号、设备偏好与连接服务。" />
    <nav className="integration-tabs" aria-label="账号与集成分类"><Tabs value={section} onChange={setSection} items={SECTIONS.map(({ value, label, icon: Icon }) => ({ value, label: <><Icon size={19} aria-hidden="true" /><span>{label}</span></> }))} /></nav>
    {['onebot', 'api', 'bili'].includes(section) && watch && <p className="integration-scope"><Shield size={17} aria-hidden="true" /><span>配置随所选手表分别保存</span></p>}
    {section === 'overview' && <MyOverview onSection={setSection} />}
    {section === 'onebot' && <OneBotPanel />}
    {section === 'api' && <ExternalApiPanel />}
    {section === 'bili' && <BiliPanel />}
    {section === 'links' && <LinksPanel />}
    {section === 'appearance' && <AppearancePanel />}
  </div>;
}

function MyOverview({ onSection }: { onSection: (section: string) => void }) {
  const { account, watch, watchId, navigate, refreshAll, tokenInvalid, watchError } = useApp();
  const overview = useResource(() => watchId ? api('/api/watch/' + encodeURIComponent(watchId) + '/overview', { timeout: 15000 }) : Promise.resolve(null), [watchId]);
  const status = useResource(() => watchId ? api('/api/watch/' + encodeURIComponent(watchId) + '/status') : Promise.resolve(null), [watchId], 30000);
  const autoAgree = useResource(() => watchId ? api('/api/watch/' + encodeURIComponent(watchId) + '/autoagree') : Promise.resolve(null), [watchId]);
  const [operation, setOperation] = useState('');
  const info: any = overview.data;
  const live: any = status.data;
  const loggedIn = !!account?.loggedIn && !tokenInvalid;
  const battery = live?.battery ?? info?.batteryInfo?.battery ?? watch?.battery;
  const online = live ? live.onlineStatus : info?.onlineStatus ?? watch?.onlineStatus;
  const classMode = Number(info?.classModes?.[0]?.classSwitch) === 1;
  const lastSeen = live?.lastSeenAt || info?.status?.lastSeenAt;
  const lastLat = live?.lastLat ?? info?.status?.lastLat;
  const lastLng = live?.lastLng ?? info?.status?.lastLng;
  const lastAddress = live?.lastAddress || info?.status?.lastAddress;
  const batteryAt = live?.batteryAt || info?.batteryInfo?.batteryAt;
  const batteryKind = live?.batteryTimeKind || info?.batteryInfo?.batteryTimeKind;
  const switchSetting = async (kind: 'classmode' | 'autoagree', checked: boolean) => {
    setOperation(kind);
    try {
      await post('/api/watch/' + encodeURIComponent(watchId) + (kind === 'classmode' ? '/settings/classmode' : '/autoagree'), kind === 'classmode' ? { disabled: checked } : { enabled: checked });
      await (kind === 'classmode' ? overview.reload() : autoAgree.reload());
      toast('设置已保存', 'success');
    } catch (error: any) { toast(error.message || '设置失败', 'error'); }
    finally { setOperation(''); }
  };
  const shortcuts = [
    { label: 'AI 助手', description: '自动回复与识图', icon: Bot, action: () => navigate('ai') },
    { label: 'OneBot 接入', description: '连接你的机器人', icon: Cable, action: () => onSection('onebot') },
    { label: 'B 站点播', description: '视频与评论长图', icon: Radio, action: () => onSection('bili') },
    { label: '运行日志', description: '查看服务与连接状态', icon: ScrollText, action: () => navigate('logs') },
    { label: '公告', description: '项目动态与更新说明', icon: Bell, action: () => navigate('announcements') },
  ];
  return <div className="stack integration-overview">
  {!!watchError && <ErrorState error={watchError} onRetry={refreshAll} />}
  <Card title="家长账号" className="integration-account-summary" action={<Badge tone={loggedIn ? 'success' : tokenInvalid ? 'warning' : 'neutral'}>{loggedIn ? '已登录' : tokenInvalid ? '登录已过期' : '未登录'}</Badge>}>
    <div className="integration-account-identity"><span className="integration-account-avatar" aria-hidden="true"><UserRound size={30} strokeWidth={1.6} /></span><div><h3>{loggedIn ? account?.userName || '我的家长账号' : tokenInvalid ? '重新连接家长账号' : '连接你的家长账号'}</h3><p>{loggedIn ? '管理已绑定手表和账号设置' : tokenInvalid ? '重新登录后恢复手表功能。' : '登录后同步手表，查看位置和收发消息。'}</p></div></div>
    {loggedIn && <CopyValue label="mobileId" value={account?.mobileId} />}
    <div className="action-row integration-card-actions integration-account-actions"><Button onClick={() => navigate('account')}>{loggedIn ? '切换账号' : tokenInvalid ? '重新登录' : '登录家长端账号'}</Button>
      {loggedIn && <><Button variant="secondary" onClick={() => navigate('bind')}>绑定手表</Button>
        <ConfirmAction label="退出账号" title="退出当前账号？" description="退出家长端账号后，需要重新登录才能使用手表功能。" onConfirm={async () => { await post('/api/account/logout'); await refreshAll(); navigate('account'); toast('已退出账号', 'success'); }} />
      </>}
    </div>
  </Card>
  {loggedIn && watchId ? <div className="integration-device-layout"><Card title="当前设备" className="integration-device-summary" action={<Button variant="ghost" size="icon" aria-label="刷新设备状态" onClick={() => { overview.reload(); status.reload(); }}><RefreshCw size={20} /></Button>}>
    <div className="integration-profile-card"><div className="integration-profile-avatar">{info?.avatarUrl ? <img src={info.avatarUrl} alt="手表头像" /> : <Watch size={29} aria-hidden="true" />}</div><div className="integration-profile-name"><h3>{watch?.name || watchId}</h3><p>{[info?.account?.model || watch?.model, info?.account?.number || watch?.number].filter(Boolean).join(' · ') || '已绑定手表'}</p></div><div className="integration-battery"><span>{battery != null ? battery : '—'}{battery != null && <small>%</small>}</span><Badge tone={online === true ? 'success' : 'neutral'}>{online === true ? '在线' : online === false ? '离线' : '状态未知'}</Badge></div></div>
    {overview.loading && !info ? <LoadingState /> : overview.error ? <ErrorState error={overview.error} onRetry={overview.reload} /> : <>
      <CopyValue label="IMEI" value={info?.account?.imei} /><StatusRow label="在线状态">{online === true ? '在线' : online === false ? '离线' : '状态未知'}</StatusRow>
      <StatusRow label="电量时间">{batteryKind === 'received' ? '接收于 ' : ''}{timeLabel(batteryAt)}</StatusRow>
      {lastSeen && <StatusRow label="最近收到通知">{timeLabel(lastSeen)}</StatusRow>}
      {lastLat != null && <StatusRow label="最近上报位置">{lastAddress || `${lastLat}, ${lastLng}`}</StatusRow>}
      {lastLat != null && <StatusRow label="位置时间">{timeLabel(live?.lastLocAt || info?.status?.lastLocAt)}</StatusRow>}
      <p className="muted integration-note">通知时间代表服务器收到消息的时间，不能据此判断手表在线。</p><div className="action-row integration-card-actions"><Button variant="secondary" onClick={() => navigate('overview')}>完整设备概览<ArrowUpRight size={18} /></Button></div>
    </>}
  </Card><Card title="设备偏好" className="integration-preferences-summary" action={<span className="integration-card-icon" aria-hidden="true"><Settings2 size={22} /></span>}>
    <div className="integration-setting-row"><div><strong>上课禁用</strong><p className="muted">在设定时段内限制手表功能</p></div><Toggle label="上课禁用" checked={classMode} disabled={!!operation || !info} onChange={(checked) => switchSetting('classmode', checked)} /></div>
    <div className="integration-setting-row"><div><strong>自动同意好友</strong><p className="muted">自动处理当前手表的好友申请</p></div><Toggle label="自动同意好友" checked={!!(autoAgree.data as any)?.enabled} disabled={!!operation || autoAgree.loading} onChange={(checked) => switchSetting('autoagree', checked)} /></div>
    {autoAgree.error && <ErrorState error={autoAgree.error} onRetry={autoAgree.reload} />}
    <div className="integration-setting-row"><div><strong>解绑手表</strong><p className="muted">将当前设备从账号中移除</p></div><ConfirmAction label="解绑" title={`解绑「${watch?.name || watchId}」？`} description="解绑后，此手表会从当前账号移除。" disabled={!watch?.relationId} onConfirm={async () => { await post('/api/watch/' + encodeURIComponent(watchId) + '/unbind', { relationId: watch.relationId }); await refreshAll(); toast('手表已解绑', 'success'); }} /></div>
  </Card></div> : loggedIn && <Card className="integration-no-watch"><EmptyState icon={<Watch size={30} />} title={watchError ? '暂时无法读取手表' : '添加你的第一块手表'} description={watchError ? '恢复连接后，设备状态与偏好会显示在这里。' : '绑定手表后，就能设置上课禁用和自动同意好友。'} action={<Button onClick={() => watchError ? refreshAll() : navigate('bind')}>{watchError ? '重新获取' : '绑定手表'}<ArrowUpRight size={18} /></Button>} /></Card>}
  <Card title="连接与扩展" description="常用服务与管理入口。" className="integration-tools"><div className="integration-shortcut-grid">{shortcuts.map(({ label, description, icon: Icon, action }) => <button type="button" key={label} className="integration-shortcut" onClick={action}><span className="integration-shortcut-icon"><Icon size={23} aria-hidden="true" /></span><span><strong>{label}</strong><small>{description}</small></span><ArrowUpRight size={18} className="muted" aria-hidden="true" /></button>)}</div></Card>
  </div>;
}
