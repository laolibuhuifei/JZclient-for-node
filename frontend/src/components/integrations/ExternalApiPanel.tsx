import React, { useState } from 'react';
import { Code2, RefreshCw, Shield } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, toast } from '../ui';
import { ConfirmAction, CopyValue, StatusRow } from './shared';

export default function ExternalApiPanel() {
  const { watchId, watch } = useApp();
  const resource = useResource(() => api('/api/genius-api'), [watchId]);
  const [busy, setBusy] = useState(false);
  const data: any = resource.data;
  if (resource.loading && !data) return <LoadingState />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  const current = data?.watches?.find((entry: any) => String(entry.watchId) === String(watchId)) || { enabled: false, token: '', name: watch?.name || watchId };
  const base = window.location.origin + '/api/ext';
  const suffix = '?token=' + encodeURIComponent(current.token || '');
  const toggle = async () => {
    setBusy(true);
    try { await post('/api/genius-api/config', { watchId, enabled: !current.enabled }); await resource.reload(); toast(current.enabled ? '已关闭本表接口' : '已启用本表接口', 'success'); }
    catch (error: any) { toast(error.message || '保存失败', 'error'); }
    finally { setBusy(false); }
  };
  return <div className="integration-api-layout integration-panel"><Card title={<span className="integration-title"><Shield size={25} aria-hidden="true" />对外 API</span>} className="integration-service-card" description="每块手表的独立接口，可供第三方脚本和机器人调用。" action={<Button variant="ghost" size="icon" onClick={resource.reload} aria-label="刷新对外 API"><RefreshCw size={20} /></Button>}>
    {!watchId ? <EmptyState title="先选择一块手表" description="启用后会为这块手表生成单独的访问令牌。" /> : <>
      <StatusRow label="当前手表">{current.name || watchId}</StatusRow><StatusRow label="接口状态"><Badge tone={current.enabled ? 'success' : 'neutral'}>{current.enabled ? '已启用' : '未启用'}</Badge></StatusRow>
      {current.enabled && current.token && <><CopyValue label="接口令牌" value={current.token} secret /><CopyValue label="好友列表" value={base + '/friends' + suffix} secret /><CopyValue label="加好友口令" value={base + '/genius' + suffix} secret /></>}
      <div className="action-row integration-card-actions"><Button variant={current.enabled ? 'secondary' : 'primary'} loading={busy} onClick={toggle}>{busy ? '保存中…' : current.enabled ? '关闭本表接口' : '为本表启用'}</Button>
        {current.enabled && <ConfirmAction variant="secondary" label="重置令牌" title="重置本表接口令牌？" description="旧令牌立即失效，请随后更新第三方脚本和机器人。" onConfirm={async () => { await post('/api/genius-api/token', { watchId }); await resource.reload(); toast('令牌已重置', 'success'); }} />}
      </div>
    </>}
  </Card><Card title={<span className="integration-title"><Code2 size={25} aria-hidden="true" />接口说明</span>} description="四个接口共用当前手表的独立令牌。" className="integration-api-reference">
    <div className="integration-api-list"><div><code>GET /api/ext/friends</code><span>好友列表</span></div><div><code>GET /api/ext/friends/&lt;id&gt;</code><span>好友详情，可使用记录 ID、friendId、IM 账号或号码</span></div><div><code>DELETE /api/ext/friends/&lt;id&gt;?confirm=&lt;id&gt;</code><span>删除好友，确认值必须与记录 ID 一致</span></div><div><code>GET /api/ext/genius</code><span>加好友口令</span></div></div>
    <p className="muted integration-note">令牌只对应一块手表，不需要 WebUI 访问令牌；请求中指定其他手表会被拒绝。</p>
  </Card></div>;
}
