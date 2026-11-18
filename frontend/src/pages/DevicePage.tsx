import React from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Button, EmptyState, LoadingState } from '../components/ui';
import HealthPanel from '../components/device/HealthPanel';
import WifiPanel from '../components/device/WifiPanel';
import AppsPanel from '../components/device/AppsPanel';
import AlarmsPanel from '../components/device/AlarmsPanel';
import ProfilePanel from '../components/device/ProfilePanel';
import FriendsPanel from '../components/device/FriendsPanel';
import ContactsPanel from '../components/device/ContactsPanel';
import SettingsPanel from '../components/device/SettingsPanel';
import HiddenPanel from '../components/device/HiddenPanel';
import '../components/device/device.css';

const panels: Record<string, React.ComponentType<{ watchId: string; caps?: any }>> = {
  health: HealthPanel, wifi: WifiPanel, apps: AppsPanel, alarms: AlarmsPanel,
  profile: ProfilePanel, friends: FriendsPanel, contacts: ContactsPanel, settings: SettingsPanel, hidden: HiddenPanel,
};
const featureModules: Record<string, number[]> = { health: [2642], wifi: [2513], apps: [72, 3171] };

function DeviceContent({ watchId, page }: { watchId: string; page: string }) {
  const resource = useResource<any>(async signal => {
    try { return await api(`/api/watch/${encodeURIComponent(watchId)}/capabilities`, { signal }); }
    catch (error: any) { if (signal?.aborted) throw error; return null; }
  }, [watchId]);
  const ids = featureModules[page];
  const records = ids?.map(id => resource.data?.modules?.[id]).filter(record => record && record.display != null) || [];
  const unsupported = ids && records.length === ids.length && records.every(record => Number(record.display) !== 0);
  if (ids && resource.loading && !resource.data) return <LoadingState />;
  if (unsupported) return <EmptyState title="当前手表暂不支持此功能" description={records.map(record => record.tips).filter(Boolean).join('；') || '此型号没有开放该功能。'} action={<Button variant="secondary" onClick={resource.reload}>重新检查</Button>} />;
  const Panel = panels[page];
  return Panel ? <Panel key={`${watchId}:${page}`} watchId={watchId} caps={resource.data} /> : <EmptyState title="未找到设备功能" />;
}

export default function DevicePage() {
  const { watchId, page, navigate } = useApp();
  if (!watchId) return <EmptyState title="请先选择一块手表" description="登录账号并绑定手表后，即可管理设备功能。" action={<Button onClick={() => navigate('account')}>前往账号</Button>} />;
  return <div className={`device-page device-page-${page}`}><DeviceContent watchId={watchId} page={page} /></div>;
}
