import React, { useEffect, useState } from 'react';
import { Copy, KeyRound, RefreshCw, Trash2, UsersRound } from 'lucide-react';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Toggle, toast } from '../ui';

function formatTime(value: any) {
  const timestamp = Number(value);
  if (!timestamp || !Number.isFinite(timestamp)) return '—';
  const date = new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false });
}

function friendName(friend: any) { return String(friend.friendName || friend.friendRealName || '未命名好友'); }
function safeImage(value: any) {
  const url = String(value || '');
  return /^https?:\/\//i.test(url) || /^\/(?!\/)/.test(url) ? url : '';
}

export default function FriendsPanel({ watchId }: { watchId: string; caps?: any }) {
  const base = `/api/watch/${encodeURIComponent(watchId)}`;
  const { data, loading, error, reload } = useResource(() => api(`${base}/friends`), [watchId]);
  const agreement = useResource(() => api(`${base}/autoagree`), [watchId]);
  const [changingAgreement, setChangingAgreement] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);
  const [deletePending, setDeletePending] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const command = useResource(() => commandOpen ? api(`${base}/genius`) : Promise.resolve(null), [watchId, commandOpen]);
  const friends: any[] = Array.isArray(data?.friends) ? data.friends : [];

  useEffect(() => { setDeleting(null); setCommandOpen(false); }, [watchId]);

  const changeAgreement = async (enabled: boolean) => {
    if (changingAgreement) return;
    setChangingAgreement(true);
    try {
      await post(`${base}/autoagree`, { enabled });
      await agreement.reload();
      toast(enabled ? '已开启自动同意好友申请' : '已关闭自动同意好友申请', 'success');
    } catch (failure: any) {
      toast(failure?.message || '修改自动同意设置失败', 'danger');
    } finally { setChangingAgreement(false); }
  };

  const removeFriend = async () => {
    if (!deleting || deletePending) return;
    setDeletePending(true);
    try {
      await api(`${base}/friends/${encodeURIComponent(String(deleting.id))}`, { method: 'DELETE' });
      setDeleting(null);
      toast('好友已删除', 'success');
      reload();
    } catch (failure: any) {
      toast(failure?.message || '删除好友失败', 'danger');
    } finally { setDeletePending(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('已复制', 'success'); }
    catch { toast('复制失败，请手动选择并复制', 'danger'); }
  };

  return <div className="device-friends-page stack">
    <PageHeader title="手表好友" description="查看宝贝的好友，分享加好友口令。" actions={<>
      <Button variant="secondary" onClick={reload} disabled={loading} aria-label="刷新好友列表"><RefreshCw size={16} />刷新</Button>
      <Button onClick={() => setCommandOpen(true)}><KeyRound size={16} />加好友口令</Button>
    </>} />
    <div className="device-people-layout">
    <Card title="好友列表" action={<Badge>{friends.length} 位好友</Badge>}>
      {loading && !data ? <LoadingState /> : error ? <ErrorState error={error} onRetry={reload} /> : !friends.length ? <EmptyState title="暂无好友" description="使用加好友口令，让其他手表添加宝贝。" /> : <div role="list">
        {friends.map((friend, index) => <div role="listitem" key={friend.id ?? index} className="device-item device-person-item">
          <span className="device-icon device-person-avatar" aria-hidden="true">
            {safeImage(friend.avatar) ? <img src={safeImage(friend.avatar)} alt="" loading="lazy" /> : friendName(friend).slice(0, 1)}
          </span>
          <div className="device-item-main"><strong className="device-item-title">{friendName(friend)}</strong><p className="device-item-description">{friend.number || '未提供号码'}<span className="device-data-note">绑定号 {friend.bindNumber || '—'}</span></p></div>
          <Button variant="ghost" size="icon" title="删除好友" onClick={() => setDeleting(friend)} disabled={friend.id == null} aria-label={`删除好友 ${friendName(friend)}`}><Trash2 size={19} /></Button>
        </div>)}
      </div>}
    </Card>
    <Card title="好友申请" description="开启后，客户端保持消息连接并自动同意当前手表收到的好友申请。" action={<UsersRound size={19} />}>
      {agreement.error ? <ErrorState error={agreement.error} onRetry={agreement.reload} /> : <Toggle label="自动同意好友申请" checked={!!agreement.data?.enabled} disabled={agreement.loading || changingAgreement} onChange={changeAgreement} />}
    </Card>
    </div>
    <Modal open={!!deleting} closeable={!deletePending} onClose={() => { if (!deletePending) setDeleting(null); }} title="删除好友" description={`确认将“${deleting ? friendName(deleting) : ''}”从当前手表的好友中删除？`} footer={<>
      <Button variant="secondary" disabled={deletePending} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={deletePending} onClick={removeFriend}>{deletePending ? '正在删除…' : '确认删除'}</Button>
    </>}><p className="muted">删除后，如需恢复好友关系，需要重新添加。</p></Modal>
    <Modal open={commandOpen} className="device-command-dialog" onClose={() => setCommandOpen(false)} title="加好友口令" description="在另一块手表上使用此口令添加好友。" footer={<Button variant="secondary" onClick={() => setCommandOpen(false)}>关闭</Button>}>
      {command.loading || !command.data && !command.error ? <LoadingState /> : command.error ? <ErrorState error={command.error} onRetry={command.reload} /> : <div className="stack">
        <div className="device-command-row"><span className="muted">手表账号</span><strong className="mono">{command.data?.geniusNumber || '—'}</strong></div>
        {command.data?.command ? <>
          <div className="device-command-value"><span className="muted">加好友口令</span><strong className="mono">{command.data.command.command || '—'}</strong>{command.data.command.command && <Button variant="ghost" size="icon" aria-label="复制加好友口令" onClick={() => copy(String(command.data.command.command))}><Copy size={19} /></Button>}</div>
          {command.data.command.expireTime && <div className="device-command-row"><span className="muted">有效期至</span><span>{formatTime(command.data.command.expireTime)}</span></div>}
        </> : <p className="muted">当前没有可用口令，请稍后重试。</p>}
        {command.data?.config?.commandExpireDescription && <p className="muted">{command.data.config.commandExpireDescription}</p>}
      </div>}
    </Modal>
  </div>;
}
