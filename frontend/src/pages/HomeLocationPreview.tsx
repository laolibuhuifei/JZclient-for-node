import React from 'react';
import { ArrowUpRight, MapPin, MapPinOff, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Button, EmptyState, ErrorState, Skeleton } from '../components/ui';
import TileMap from '../components/location/TileMap';
import { formatLocationTime, readCoordinates } from '../components/location/locationUtils';
import './home-location-preview.css';

export type HomeLocationPreviewProps = {
  watchId: string;
  onOpen: () => void;
};

// Switching devices discards the previous device's location before the next request starts.
export default function HomeLocationPreview(props: HomeLocationPreviewProps) {
  return <WatchLocationPreview key={props.watchId} {...props} />;
}

function WatchLocationPreview({ watchId, onOpen }: HomeLocationPreviewProps) {
  const resource = useResource((signal?: AbortSignal) => api(`/api/watch/${encodeURIComponent(watchId)}/location`, { signal }), [watchId]);
  const data = resource.data;
  const location = data?.location || {};
  const coordinates = readCoordinates(location);
  const address = String(location.desc || location.road || location.poi || location.address || '手表最近上报位置');
  const updatedAt = location.createTime || location.locationPushTime || location.locationTime || location.time;
  const radius = location.radius == null ? undefined : Number(location.radius);
  const status = data?.onlineStatus === false ? '手表离线 · 最近位置' : data?.onlineStatus === true ? '最近上报位置' : '在线状态未知';

  return <section className="home-location-preview" aria-label="手表最近位置">
    <div className="home-location-heading"><div><h3><MapPin size={19} aria-hidden="true" />最新位置</h3>{data && <span>{status}</span>}</div><div className="home-location-actions">
      <Button variant="ghost" size="icon" onClick={() => resource.reload()} disabled={resource.loading} aria-busy={resource.loading} aria-label="刷新手表位置" title="刷新手表位置"><RefreshCw size={18} aria-hidden="true" /></Button>
      <Button variant="ghost" onClick={onOpen} aria-label="打开定位页">打开定位页<ArrowUpRight size={17} aria-hidden="true" /></Button>
    </div></div>
    {resource.loading && !data ? <div className="home-location-loading" role="status" aria-label="正在读取手表位置"><Skeleton /><span className="sr-only">正在读取手表最近上报的位置…</span></div>
      : resource.error && !data ? <ErrorState error={resource.error} onRetry={resource.reload} />
      : coordinates ? <>
        <TileMap latitude={coordinates.latitude} longitude={coordinates.longitude} radius={Number.isFinite(radius) ? radius : undefined} name="手表最近上报位置" />
        <div className="home-location-summary"><strong>{address}</strong><p>{formatLocationTime(updatedAt)}{radius != null && Number.isFinite(radius) && radius >= 0 ? ` · 精度 ${radius} 米` : ''}</p><span className="home-location-coordinates">{coordinates.latitude.toFixed(6)}, {coordinates.longitude.toFixed(6)}</span></div>
      </> : <EmptyState icon={<MapPinOff size={27} aria-hidden="true" />} title="暂无位置数据" description="手表上报位置后，会显示在这里。" action={<Button variant="secondary" onClick={resource.reload} disabled={resource.loading} aria-label="重新读取手表位置"><RefreshCw size={17} aria-hidden="true" />重新读取</Button>} />}
    {resource.error && data && <div className="home-location-stale" role="status"><span>位置刷新失败，已保留上次读取的内容。</span><Button variant="ghost" onClick={resource.reload} disabled={resource.loading} aria-label="重试读取手表位置">重试</Button></div>}
  </section>;
}
