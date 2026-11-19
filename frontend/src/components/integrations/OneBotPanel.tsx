import React, { useState } from 'react';
import { Cable, Globe, Radio, RefreshCw, Settings2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, Tabs, Toggle, toast } from '../ui';
import { ConfirmAction, CopyValue, SessionPicker, StatusRow } from './shared';

export default function OneBotPanel() {
  const { watchId, watch, navigate } = useApp();
  const resource = useResource(() => api('/api/onebot'), [watchId]);
  const [editing, setEditing] = useState(false);
  const data: any = resource.data;
  if (resource.loading && !data) return <LoadingState />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (!data) return null;
  const current = (data.watches || []).find((entry: any) => String(entry.watchId) === String(watchId)) || {
    watchId, name: watch?.name || watchId, enabled: false, running: false, keys: [], auto: true,
    http: { enabled: true, host: '0.0.0.0', port: 0 }, ws: { enabled: true, host: '0.0.0.0', port: 0 }, wsClient: {},
  };
  const hostname = window.location.hostname || '127.0.0.1';
  const urlHost = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  const reverse = current.wsClient || {};
  return <div className="stack integration-panel integration-onebot-panel">
    <Card title={<span className="integration-title"><Cable size={25} aria-hidden="true" />OneBot v11</span>} description="让 AstrBot、NoneBot 等机器人接入手表会话。" className="integration-service-card" action={<Button variant="ghost" size="icon" onClick={resource.reload} aria-label="刷新 OneBot 状态"><RefreshCw size={20} /></Button>}>
      {!watchId ? <EmptyState title="先选择一块手表" description="每块手表拥有独立的端口、令牌和会话范围。" action={<Button onClick={() => navigate('account')}>登录或管理账号</Button>} /> : <>
        <div className="integration-service-overview"><StatusRow label="当前手表">{current.name || watch?.name || watchId}</StatusRow>
        <StatusRow label="服务状态"><Badge tone={current.running ? 'success' : current.enabled ? 'warning' : 'neutral'}>{current.running ? '运行中' : current.enabled ? '启用但未运行' : '已关闭'}</Badge>{current.clients ? ` · ${current.clients} 个客户端` : ''}</StatusRow></div>
        {current.enabled && <>
          <div className="integration-transport-grid">
          {current.http?.enabled && <section className="integration-transport"><h3><Globe size={20} aria-hidden="true" />HTTP API<Badge tone={current.http.running ? 'success' : 'warning'}>{current.http.running ? '已监听' : '未监听'}</Badge></h3><CopyValue label="地址" value={current.http.port ? `http://${urlHost}:${current.http.port}` : ''} /><CopyValue label="HTTP 令牌" value={current.http.token} secret /></section>}
          {current.ws?.enabled && <section className="integration-transport"><h3><Radio size={20} aria-hidden="true" />正向 WebSocket<Badge tone={current.ws.running ? 'success' : 'warning'}>{current.ws.running ? '已监听' : '未监听'}</Badge></h3><CopyValue label="地址" value={current.ws.port ? `ws://${urlHost}:${current.ws.port}` : ''} /><CopyValue label="WS 令牌" value={current.ws.token} secret /></section>}
          {reverse.enabled && <section className="integration-transport"><h3><Cable size={20} aria-hidden="true" />反向 WebSocket</h3><CopyValue label="机器人地址" value={reverse.url} /><StatusRow label="反向连接"><Badge tone={reverse.connected ? 'success' : 'warning'}>{reverse.connected ? '已连接' : reverse.state === 'connecting' ? '连接中' : '等待重连'}</Badge></StatusRow></section>}
          </div>
          <div className="integration-service-overview"><StatusRow label="self_id"><code>{data.selfId || '—'}</code></StatusRow><StatusRow label="会话范围">{current.auto ? '自动匹配' : '手动指定'} · {current.keys?.length ? `${current.keys.length} 个会话` : '尚未匹配，暂不收发'}</StatusRow></div>
          {!!current.keys?.length && <div className="integration-chips">{current.keys.map((key: string) => <Badge key={key}>{(data.targets || []).find((target: any) => target.key === key)?.name || key}</Badge>)}</div>}
        </>}
        <div className="action-row integration-card-actions"><Button onClick={() => setEditing(true)}><Settings2 size={19} />配置接入</Button><Button variant="secondary" onClick={() => navigate('logs')}>查看运行日志</Button></div>
      </>}
    </Card>
    <Card title="连接方式" description="选择适合机器人所在环境的连接方式。"><div className="integration-method-grid">
      <div className="integration-mini"><Globe size={23} /><strong>HTTP API</strong><p className="muted">机器人通过 HTTP 调用。每块表使用独立端口和令牌。</p></div>
      <div className="integration-mini"><Radio size={23} /><strong>正向 WebSocket</strong><p className="muted">机器人主动连接这里显示的 WS 地址，协议选择 OneBot v11。</p></div>
      <div className="integration-mini"><Cable size={23} /><strong>反向 WebSocket</strong><p className="muted">由手表客户端连接机器人。仅使用反向连接时可关闭 HTTP 和正向 WS。</p></div>
    </div></Card>
    {editing && <OneBotEditor key={watchId} data={data} current={current} watchId={watchId} onClose={() => setEditing(false)} onSaved={resource.reload} />}
  </div>;
}

function OneBotEditor({ data, current, watchId, onClose, onSaved }: any) {
  const [tab, setTab] = useState('watch');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    enabled: !!current.enabled,
    http: { enabled: current.http?.enabled !== false, host: current.http?.host || '0.0.0.0', port: current.http?.port || '' },
    ws: { enabled: current.ws?.enabled !== false, host: current.ws?.host || '0.0.0.0', port: current.ws?.port || '' },
    wsClient: { enabled: !!current.wsClient?.enabled, url: current.wsClient?.url || '', token: current.wsClient?.token || '', reconnect: current.wsClient?.reconnect || 5 },
  });
  const [automatic, setAutomatic] = useState(current.auto !== false);
  const [keys, setKeys] = useState<string[]>(current.keys || []);
  const [heartbeat, setHeartbeat] = useState(data.heartbeat ?? 30);
  const [qqCompat, setQqCompat] = useState(data.qqCompat !== false);
  const setTransport = (kind: 'http' | 'ws' | 'wsClient', key: string, value: any) => setForm((previous) => ({ ...previous, [kind]: { ...previous[kind], [key]: value } }));
  async function save() {
    if (tab === 'watch' && !automatic && !keys.length) { toast('请选择至少一个会话，或启用自动匹配', 'error'); return; }
    if (tab === 'watch' && form.wsClient.enabled && !/^wss?:\/\//i.test(form.wsClient.url.trim())) { toast('反向 WS 地址应以 ws:// 或 wss:// 开头', 'error'); return; }
    setBusy(true);
    try {
      if (tab === 'common') {
        await post('/api/onebot/config', { heartbeat: Number(heartbeat), qqCompat });
        toast('通用设置已保存并应用到所有手表', 'success');
      } else {
        const result: any = await post('/api/onebot/watch', { watchId, ...form,
          http: { ...form.http, port: Number(form.http.port) || 0 }, ws: { ...form.ws, port: Number(form.ws.port) || 0 },
          wsClient: { ...form.wsClient, url: form.wsClient.url.trim(), token: form.wsClient.token.trim(), reconnect: Number(form.wsClient.reconnect) || 5 }, targets: automatic ? [] : keys });
        const saved = result.watches?.find((entry: any) => String(entry.watchId) === String(watchId));
        toast(saved?.enabled && !saved.running ? '已保存，但服务未启动，请检查端口和运行日志' : '接入设置已保存', saved?.enabled && !saved.running ? 'error' : 'success');
      }
      await onSaved();
      onClose();
    } catch (error: any) { toast(error.message || '保存失败', 'error'); }
    finally { setBusy(false); }
  }
  const reset = async (which: string) => { await post('/api/onebot/watch/token', { watchId, which }); await onSaved(); toast('令牌已重置，旧令牌立即失效', 'success'); };
  return <Modal open onClose={() => { if (!busy) onClose(); }} closeable={!busy} className="integration-dialog" title="OneBot 接入设置" description={current.name || watchId} size="lg" footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button loading={busy} onClick={save}>{busy ? '保存中…' : tab === 'common' ? '保存通用设置' : '保存本表设置'}</Button></>}>
    <fieldset className="integration-editor-fieldset stack" disabled={busy}><Tabs items={[{ value: 'watch', label: '当前手表', disabled: busy }, { value: 'common', label: '通用设置', disabled: busy }]} value={tab} onChange={setTab} />
      {tab === 'common' ? <div className="stack"><Toggle label="QQ 兼容模式" checked={qqCompat} onChange={setQqCompat} /><p className="muted integration-note">开启后，部分手表不支持的 QQ 动作会返回兼容结果，适合已有机器人插件；关闭可用于严格排查。</p><Field label="心跳间隔（秒）" hint="所有手表共用，0 表示不发送心跳。"><Input type="number" min={0} max={600} value={heartbeat} onChange={(event) => setHeartbeat(event.target.value)} /></Field></div> : <>
        <Toggle label="启用当前手表的 OneBot" checked={form.enabled} onChange={(enabled) => setForm({ ...form, enabled })} />
        <div className="grid-2">{(['http', 'ws'] as const).map((kind) => <section className="integration-section" key={kind}>
          <Toggle label={kind === 'http' ? 'HTTP API' : '正向 WebSocket'} checked={form[kind].enabled} onChange={(enabled) => setTransport(kind, 'enabled', enabled)} />
          <Field label="监听地址"><Input value={form[kind].host} onChange={(event) => setTransport(kind, 'host', event.target.value)} /></Field>
          <Field label="端口" hint="留空或 0 自动分配。"><Input type="number" min={0} max={65535} value={form[kind].port} onChange={(event) => setTransport(kind, 'port', event.target.value)} /></Field>
          <ConfirmAction label="重置令牌" variant="secondary" disabled={busy} title={`重置 ${kind.toUpperCase()} 令牌？`} description="旧令牌会立即失效，需要同步更新机器人连接配置。" onConfirm={() => reset(kind)} />
        </section>)}</div>
        <section className="integration-section stack"><Toggle label="反向 WebSocket" checked={form.wsClient.enabled} onChange={(enabled) => setTransport('wsClient', 'enabled', enabled)} />
          <Field label="机器人 WS 地址"><Input value={form.wsClient.url} placeholder="ws://127.0.0.1:6199/ws" onChange={(event) => setTransport('wsClient', 'url', event.target.value)} /></Field>
          <div className="grid-2"><Field label="access_token"><Input type="password" autoComplete="off" value={form.wsClient.token} onChange={(event) => setTransport('wsClient', 'token', event.target.value)} /></Field><Field label="重连间隔（秒）"><Input type="number" min={1} max={3600} value={form.wsClient.reconnect} onChange={(event) => setTransport('wsClient', 'reconnect', event.target.value)} /></Field></div>
        </section>
        <section className="integration-section"><h3>会话范围</h3><SessionPicker targets={data.targets || []} selected={keys} onChange={setKeys} automatic={automatic} onAutomaticChange={setAutomatic} disabled={busy} /></section>
      </>}
    </fieldset>
  </Modal>;
}
