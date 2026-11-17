import React from 'react';
import { RefreshCw, Wifi } from 'lucide-react';
import { api } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from '../ui';

export default function WifiPanel({ watchId }: { watchId: string; caps?: any }) {
  const resource = useResource<any>((signal) => api(`/api/watch/${encodeURIComponent(watchId)}/wifi`, { signal }), [watchId]);
  if (resource.loading && !resource.data) return <LoadingState />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const data = resource.data || {};
  const list = Array.isArray(data.list) ? data.list : [];
  const maximum = data.max != null && typeof data.max !== 'object' ? data.max : data.max?.maxWifiCount ?? data.max?.max;
  return <div className="device-wifi-page stack">
    <PageHeader title="Wi-Fi" description="查看手表已保存的无线网络和连接状态。" actions={<Button variant="secondary" onClick={resource.reload} disabled={resource.loading}><RefreshCw size={19} />刷新</Button>} />
    {resource.error && <ErrorState error={resource.error} onRetry={resource.reload} />}
    <Card className="device-network-card" title="已保存的网络" action={<Badge>{list.length} 个</Badge>} description={maximum != null ? `最多保存 ${maximum} 个网络` : '从手表同步的无线网络列表。'}>
      {!list.length ? <EmptyState title="暂无已保存的 Wi-Fi" description="在手表上连接网络后，这里会同步显示。" /> : <div role="list">{list.map((item: any, index: number) => <div className="device-item" role="listitem" key={item.mac || `${item.wifiName}-${index}`}>
        <span className="device-icon"><Wifi size={20} /></span>
        <div className="device-item-main"><p className="device-item-title">{item.wifiName || '未命名网络'}</p><p className="device-item-description mono">{item.mac || '暂无设备地址'}</p></div>
        <Badge tone={Number(item.status) === 2 ? 'success' : 'neutral'}>{Number(item.status) === 2 ? '已连接' : item.status == null ? '状态未知' : `状态 ${item.status}`}</Badge>
      </div>)}</div>}
    </Card>
  </div>;
}
