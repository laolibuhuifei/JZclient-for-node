import React, { useState } from 'react';
import { BellRing, Camera, CircleDot, Clock3, History, MapPin, MapPinOff, MessageSquare, RefreshCw, ShieldCheck, VolumeX, Watch, Wifi } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Skeleton, Toggle, toast } from '../components/ui';
import TileMap from '../components/location/TileMap';
import { MessageDialog, PhotosPanel, TrackDialog, WifiPanel } from '../components/location/LocationPanels';
import { formatLocationTime, readCoordinates } from '../components/location/locationUtils';
import '../components/location/location.css';

export default function LocationPage() {
  const { watchId, watch, navigate } = useApp();
  if (!watchId) return <div className="location-page"><PageHeader title="定位" description="查看手表位置、历史轨迹与找回工具。" /><EmptyState title="还没有选择手表" description="选择一块已绑定的手表后查看位置。" action={<Button onClick={() => navigate('bind')}>绑定手表</Button>} /></div>;
  return <WatchLocation key={watchId} watchId={watchId} watch={watch} />;
}

function LocationSkeleton() {
  return <div className="location-loading-layout" role="status" aria-label="正在读取手表位置">
    <Skeleton className="location-loading-map" />
    <Card><Skeleton className="location-loading-title" /><div className="location-loading-fields">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} />)}</div></Card>
    <span className="sr-only">正在读取最近位置与连接状态…</span>
  </div>;
}

function WatchLocation({ watchId, watch }: { watchId: string; watch: any }) {
  const { refreshWatches } = useApp();
  const base = `/api/watch/${encodeURIComponent(watchId)}`;
  const resource = useResource((signal?: AbortSignal) => api(`${base}/location`, { signal }), [base]);
  const [trackOpen, setTrackOpen] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [panel, setPanel] = useState<'photos' | 'wifi' | null>(null);
  const [confirmation, setConfirmation] = useState<'enable' | 'disable' | 'ring' | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState('');
  const data = resource.data;
  const location = data?.location || {};
  const coordinates = readCoordinates(location);
  const lost = Number(data?.lossSwitch) === 1;
  const online = data?.onlineStatus;
  const address = String(location.desc || location.road || location.poi || '手表位置');
  const updatedAt = location.createTime || location.locationPushTime;
  const statusLabel = online === true ? '在线' : online === false ? '离线' : '状态未知';

  function ask(action: 'enable' | 'disable' | 'ring') {
    setConfirmError('');
    setConfirmation(action);
  }

  async function performConfirmed() {
    if (!confirmation || busy) return;
    setBusy(true);
    setConfirmError('');
    try {
      if (confirmation === 'ring') {
        await post(`${base}/lost/sound`, { action: 'play' });
        toast('已发送响铃指令', 'success');
      } else {
        const enabled = confirmation === 'enable';
        await post(`${base}/lost`, { enabled });
        toast(enabled ? '丢表模式已开启' : '丢表模式已关闭', 'success');
        setPanel(null);
        resource.reload();
        Promise.resolve(refreshWatches()).catch(() => {});
      }
      setConfirmation(null);
    } catch (failure) { setConfirmError(failure instanceof Error ? failure.message : '操作失败，请重试。'); }
    finally { setBusy(false); }
  }

  async function stopRinging() {
    setBusy(true);
    try { await post(`${base}/lost/sound`, { action: 'stop' }); toast('已发送停止响铃指令', 'success'); }
    catch (failure) { toast(failure instanceof Error ? failure.message : '停止响铃失败', 'error'); }
    finally { setBusy(false); }
  }

  return <div className="location-page">
    <PageHeader title="定位" description="查看最近位置、出行轨迹与手表找回工具。" actions={<Button variant="secondary" onClick={resource.reload} disabled={resource.loading} aria-busy={resource.loading}><RefreshCw size={19} aria-hidden="true" />{resource.loading ? '刷新中…' : '刷新定位'}</Button>} />
    {resource.loading && !data ? <LocationSkeleton /> : resource.error && !data ? <ErrorState error={resource.error} onRetry={resource.reload} /> : data && <>
      {resource.error && <div className="location-refresh-warning" role="status"><Clock3 size={20} aria-hidden="true" /><span>位置刷新失败，已保留上次读取的内容。<small>{resource.error?.message || String(resource.error)}</small></span><Button variant="ghost" onClick={resource.reload} disabled={resource.loading}>重试</Button></div>}
      <div className="location-layout">
        <section className="location-map-panel" aria-label="手表最近位置">
          <div className="location-map-heading"><h2><MapPin size={23} strokeWidth={1.7} aria-hidden="true" />最新位置</h2><Badge tone={online === true ? 'success' : 'neutral'}>{statusLabel}</Badge></div>
          {coordinates ? <TileMap latitude={coordinates.latitude} longitude={coordinates.longitude} radius={Number(location.radius) || undefined} name={watch?.name || '手表位置'} />
            : <div className="location-empty-map"><div><MapPinOff size={40} strokeWidth={1.6} aria-hidden="true" /><h3>暂无位置数据</h3><p className="location-hint">手表上报位置后，会显示在这里。</p></div></div>}
          <div className="location-summary">
            <div><h3>{coordinates ? address : '等待手表上报位置'}</h3><p>{coordinates ? `${formatLocationTime(updatedAt)} · 精度 ${location.radius != null ? `${location.radius} 米` : '未知'}` : '可以刷新最近位置，或查询其他日期的历史记录。'}</p></div>
            <div className="location-summary-actions"><Button variant="secondary" onClick={() => setTrackOpen(true)}><History size={19} aria-hidden="true" />历史轨迹</Button></div>
          </div>
        </section>
        <Card className="location-details-card" title="定位详情" description="以手表最近一次上报为准。">
          <dl className="location-data-list">
            <div className="location-data-item"><dt><Watch aria-hidden="true" />当前手表</dt><dd>{watch?.name || watch?.nickname || watchId}</dd></div>
            <div className="location-data-item"><dt><CircleDot aria-hidden="true" />连接状态</dt><dd><Badge tone={online === true ? 'success' : 'neutral'}>{statusLabel}</Badge></dd></div>
            <div className="location-data-item"><dt><Clock3 aria-hidden="true" />位置更新时间</dt><dd>{formatLocationTime(updatedAt)}</dd></div>
            <div className="location-data-item"><dt><MapPin aria-hidden="true" />经纬度</dt><dd className="location-coordinates">{coordinates ? `${coordinates.latitude.toFixed(6)}, ${coordinates.longitude.toFixed(6)}` : '暂无坐标'}</dd></div>
            <div className="location-data-item"><dt><CircleDot aria-hidden="true" />定位精度</dt><dd>{location.radius != null ? `${location.radius} 米` : '未知'}</dd></div>
          </dl>
        </Card>
      </div>
      <Card className="location-lost-card">
        <div className="location-lost-header">
          <div className="location-lost-title"><span className="location-section-icon"><ShieldCheck size={25} strokeWidth={1.6} aria-hidden="true" /></span><div><h2>丢表模式</h2><p>锁定手表，使用照片、留言和响铃协助找回。</p></div></div>
          <Toggle label="丢表模式" checked={lost} disabled={busy || resource.loading} onChange={enabled => ask(enabled ? 'enable' : 'disable')} />
        </div>
        {lost ? <>
          <div className="location-lost-content">
            <p className="location-hint">{online === true ? '手表在线，指令会立即下发。' : online === false ? '手表当前离线，指令会在下次联网时下发。' : '手表在线状态未知，暂时无法确认指令送达时间。'}</p>
            <div className="location-lost-actions">
              <Button variant={panel === 'photos' ? 'primary' : 'secondary'} onClick={() => setPanel(panel === 'photos' ? null : 'photos')} aria-pressed={panel === 'photos'}><Camera size={19} aria-hidden="true" />附近照片</Button>
              <Button variant={panel === 'wifi' ? 'primary' : 'secondary'} onClick={() => setPanel(panel === 'wifi' ? null : 'wifi')} aria-pressed={panel === 'wifi'}><Wifi size={19} aria-hidden="true" />附近 WiFi</Button>
              <Button variant="secondary" onClick={() => setMessageOpen(true)}><MessageSquare size={19} aria-hidden="true" />留言给拾到者</Button>
              <Button onClick={() => ask('ring')} disabled={busy}><BellRing size={19} aria-hidden="true" />响铃</Button>
              <Button variant="secondary" onClick={stopRinging} disabled={busy}><VolumeX size={19} aria-hidden="true" />停止响铃</Button>
            </div>
          </div>
        </> : <p className="location-hint">开启后手表屏幕将被锁定，并可查看附近照片与 WiFi、向拾到者留言或让手表响铃。</p>}
      </Card>
      {lost && panel === 'photos' && <PhotosPanel base={base} />}
      {lost && panel === 'wifi' && <WifiPanel base={base} />}
    </>}
    {trackOpen && <TrackDialog base={base} onClose={() => setTrackOpen(false)} />}
    {messageOpen && <MessageDialog base={base} onClose={() => setMessageOpen(false)} />}
    <Modal open={confirmation !== null} onClose={() => { if (!busy) setConfirmation(null); }} closeable={!busy} className="location-dialog"
      title={confirmation === 'enable' ? '开启丢表模式' : confirmation === 'disable' ? '关闭丢表模式' : '让手表响铃'}
      description={confirmation === 'enable' ? '开启后会锁定手表屏幕。确认开启丢表模式？' : confirmation === 'disable' ? '关闭丢表模式后，手表屏幕将解锁。确认关闭？' : '手表将播放警报音，方便你在附近寻找。确认发送响铃指令？'}
      footer={<><Button variant="secondary" onClick={() => setConfirmation(null)} disabled={busy}>取消</Button><Button onClick={performConfirmed} disabled={busy}>{busy ? '发送中…' : '确认'}</Button></>}>
      {confirmError && <p className="guard-form-error" role="alert">{confirmError}</p>}
    </Modal>
  </div>;
}
