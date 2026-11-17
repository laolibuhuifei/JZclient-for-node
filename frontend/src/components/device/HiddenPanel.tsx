import React from 'react';
import { ChevronDown, MapPin, MessageCircle, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '../ui';
import { DataRows } from './DeviceForm';
import './device-data-panels.css';

type Props = { watchId: string; caps?: any };
const listOf = (value: any): any[] => Array.isArray(value) ? value : [];
const valuesOf = (value: any, labels: Record<string, string>) => Object.entries(labels).map(([key, label]) => ({ label, value: value?.[key] }));
const nameOf = (item: any) => typeof item === 'string' ? item : item?.name || item?.cardName || item?.markName || item?.address || item?.title || item?.packageName || JSON.stringify(item);

function DetailList({ items, empty }: { items: any[]; empty: string }) {
  return items.length ? <ul className="hidden-detail-list">{items.map((item, i) => <li key={item?.id || item?.cardId || i}>{nameOf(item)}</li>)}</ul> : <p className="hidden-empty-copy">{empty}</p>;
}

function InformationGroup({ title, description, icon, children }: { title: string; description: string; icon: React.ReactNode; children: React.ReactNode }) {
  return <section className="hidden-information-group"><div className="hidden-section-heading"><span className="device-data-symbol" aria-hidden="true">{icon}</span><div><h2>{title}</h2><p>{description}</p></div></div><div className="hidden-information-grid">{children}</div></section>;
}

export default function HiddenPanel({ watchId }: Props) {
  const resource = useResource(() => watchId ? api(`/api/watch/${encodeURIComponent(watchId)}/hidden`) : Promise.resolve(null), [watchId]);
  const data: any = resource.data || {};
  if (!watchId) return <EmptyState title="请先选择一块手表" description="选择手表后查看扩展状态与更多设备信息。" />;
  if (resource.loading && !resource.data) return <LoadingState />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const whiteApps = data.whiteApps || {};
  const receive = data.receiveType || {};
  const shutdownLocations = Array.isArray(data.shutdownLocations) ? data.shutdownLocations : data.shutdownLocations?.locations || data.shutdownLocations?.list || [];

  return <div className="stack hidden-page">
    <PageHeader title="高级信息" description="查看设备状态、通信权限与扩展信息；可用数据取决于手表型号。" actions={<Button variant="secondary" disabled={resource.loading} onClick={resource.reload}><RefreshCw size={18} />刷新信息</Button>} />
    {resource.error && <ErrorState error={resource.error} onRetry={resource.reload} />}
    <InformationGroup title="设备状态" description="电源、运行模式和日常提醒。" icon={<Settings2 size={23} />}>
      <Card title="手表基础状态"><DataRows items={valuesOf(data.baseState, { powerState: '电源状态', onlineStatus: '在线状态', isWatchOff: '是否关机', offTime: '关机时间', arrearsStatus: '欠费状态', watchMode: '手表模式' })} /></Card>
      <Card title="系统模式"><DataRows items={[{ label: '当前模式', value: data.systemMode?.status == null ? '未获取' : Number(data.systemMode.status) === 1 ? '超长待机' : '标准模式' }, ...valuesOf(data.systemMode, { model: '内型号', updateTime: '更新时间' })]} /></Card>
      <Card title="上学前提醒"><DataRows items={valuesOf(data.beforeSchool, { status: '状态', operatorType: '操作人' })} /></Card>
      <Card title="关机定位"><DataRows items={valuesOf(data.shutdown, { status: '状态', nextWatchOnTime: '下次开机', firstTime: '首次定位' })} />{listOf(shutdownLocations).length > 0 && <details className="hidden-record-disclosure"><summary><span>查看关机位置记录</span><ChevronDown size={18} aria-hidden="true" /></summary><div className="hidden-shutdown-records">{listOf(shutdownLocations).map((item, i) => <div key={item.id || i}><DataRows items={Object.entries(item).map(([label, value]) => ({ label, value: value && typeof value === 'object' ? JSON.stringify(value) : value }))} /></div>)}</div></details>}</Card>
    </InformationGroup>
    <InformationGroup title="通信与权限" description="成员授权、接听设置和手表通知。" icon={<MessageCircle size={23} />}>
      <Card title="成员权限">{!listOf(data.authorizes).length ? <p className="hidden-empty-copy">暂无权限数据</p> : <ul className="hidden-authorize-list">{listOf(data.authorizes).map((item, i) => <li key={`${item.mobileId}-${item.authorizeType}-${i}`}><div><strong>{item.mobileId || '未知成员'}</strong><p>权限 {item.authorizeType ?? '未获取'}</p></div><Badge tone={Number(item.authorize) === 1 ? 'success' : 'neutral'}>{item.authorize == null ? '未获取' : Number(item.authorize) === 1 ? '允许' : '禁止'}</Badge></li>)}</ul>}</Card>
      <Card title="自动接听"><DataRows items={valuesOf(data.autoCall, { watchSwitch: '手表端接听', mobileSwitch: '家长端接听', forceCallSwitch: '强制接听' })} /></Card>
      <Card title="模式限制"><DataRows items={valuesOf(data.disableMode, { classModeWeichat: '上课可聊天', classModeCall: '上课可通话', sleepModeWeichat: '睡眠可聊天', sleepModeCall: '睡眠可通话', enduranceWeichat: '续航可聊天', enduranceCall: '续航可通话' })} /></Card>
      <Card title="短信接收设置"><DataRows items={[{ label: '接收类型', value: receive.receiveType === 0 ? '接收全部' : receive.receiveType }, { label: '短信同步', value: receive.smsSync == null ? '未获取' : Number(receive.smsSync) === 0 ? '开' : '关' }, { label: '展示全部', value: receive.isDisplayAll == null ? '未获取' : Number(receive.isDisplayAll) === 1 ? '是' : '否' }]} /></Card>
      <Card title="未读通知">{listOf(data.notices).length ? <ul className="hidden-detail-list">{listOf(data.notices).map((item, i) => <li key={item.id || i}>{item.message || 0} 条未读</li>)}</ul> : <p className="hidden-empty-copy">暂无未读通知</p>}</Card>
      <Card title="通知内容"><p className="hidden-notice-content">{data.noticeContent?.noticeDesc || '暂无通知'}</p></Card>
    </InformationGroup>
    <InformationGroup title="界面与功能" description="显示辅助和当前可用的功能。" icon={<ShieldCheck size={23} />}>
      <Card title="无障碍"><DataRows items={valuesOf(data.accessibility, { accessibilitySwitch: '无障碍', contrastSwitch: '高对比度', screenReaderSwitch: '屏幕朗读', textSize: '字号', speechLanguage: '语音语言', speechRate: '语速', speechVolume: '语音音量' })} /></Card>
      <Card title="功能白名单" description={`版本 ${whiteApps.version || '未获取'}`}><DetailList items={listOf(whiteApps.funcs)} empty="未设置功能白名单" /></Card>
    </InformationGroup>
    <InformationGroup title="地点与扩展" description="标记地点、外部服务和 NFC 卡片记录。" icon={<MapPin size={23} />}>
      <Card title="标记地点"><DetailList items={listOf(data.markAreas?.markLocationList)} empty="暂无标记地点" /></Card>
      <Card title="百度网盘">{data.baiduNetdisk ? <DataRows items={typeof data.baiduNetdisk === 'object' ? Object.entries(data.baiduNetdisk).map(([label, value]) => ({ label, value: typeof value === 'object' ? JSON.stringify(value) : value })) : [{ label: '状态', value: String(data.baiduNetdisk) }]} /> : <p className="hidden-empty-copy">未开通</p>}</Card>
      <Card title="用户协议"><DetailList items={listOf(data.userAgreement)} empty="暂无待确认协议" /></Card>
      <Card title="NFC 待处理卡片" description="丢表删卡与退款相关的待处理记录。"><DetailList items={listOf(data.nfcPending?.shiftOrDelCardVoList)} empty="暂无待处理卡片" /></Card>
      <Card title="NFC 卡片"><DetailList items={listOf(data.nfcCards)} empty="暂无 NFC 卡片" /></Card>
    </InformationGroup>
  </div>;
}
