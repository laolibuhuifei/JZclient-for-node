import React from 'react';
import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { Button, Modal } from '../components/ui';
import { BatteryRing, DetailRows, OnlineBadge, formatTime } from './HomePageParts';

type Props = { watch?: any; onClose: () => void; onOpenDetails: () => void };

export default function HomeWatchInfoDialog({ watch, onClose, onOpenDetails }: Props) {
  const fields = watch ? [
    ['设备 ID · watchId', watch.watchId], ['IMEI', watch.imei || '—'],
    ['手表号码', watch.number || '—'], ['固件版本', watch.firmware || '—'],
  ] : [];

  return <Modal open={!!watch} onClose={onClose} title="手表设备信息" description={watch?.name || '未命名手表'} className="home-watch-info-dialog" footer={<>
    <Button variant="secondary" onClick={onClose}>关闭</Button>
    <Button onClick={onOpenDetails} aria-label="设备详情">设备详情<ArrowUpRight size={18} aria-hidden="true" /></Button>
  </>}>
    {watch && <>
      <div className="home-watch-info-summary"><div><span>{watch.model || '型号待同步'}</span><OnlineBadge value={watch.online} /></div><BatteryRing value={watch.battery} compact /></div>
      <dl className="home-device-info">{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{String(value ?? '—')}</dd></div>)}</dl>
      <details className="home-device-extra"><summary><span>更多设备信息</span><ChevronDown size={18} aria-hidden="true" /></summary><DetailRows items={[
        ['绑定关系 ID', watch.relationId || '—'],
        ['电量来源', watch.batterySource === 'api' ? '接口' : watch.batterySource === 'push' ? 'IM 推送' : '—'],
        ['电量时间', watch.batteryAt ? `${watch.batteryTimeKind === 'received' ? '接收于 ' : ''}${formatTime(watch.batteryAt)}` : '—'],
        ...(watch.lastSeenAt ? [['最近收到通知', <span>{formatTime(watch.lastSeenAt)}<small>接收时间，不代表设备在线</small></span>]] as [string, React.ReactNode][] : []),
        ...(watch.lastLocation ? [['最近推送位置', <span>{watch.lastLocation.address || `${watch.lastLocation.latitude}, ${watch.lastLocation.longitude}`}<small>{formatTime(watch.lastLocation.time)}</small></span>]] as [string, React.ReactNode][] : []),
      ]} /></details>
    </>}
  </Modal>;
}
