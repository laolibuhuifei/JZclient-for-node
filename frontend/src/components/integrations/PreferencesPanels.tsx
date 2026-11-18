import React, { useRef, useState } from 'react';
import { Image, Link2, Moon, RefreshCw, Sun, Upload } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, Toggle, toast } from '../ui';
import { CopyValue, StatusRow, timeLabel } from './shared';

export function LinksPanel() {
  const resource = useResource(() => api('/api/links'));
  const [busy, setBusy] = useState(false);
  const data: any = resource.data;
  const synchronize = async () => {
    const result: any = await post('/api/links/refresh');
    await resource.reload();
    toast(result.notModified ? '链接库没有变化' : `已同步 ${result.count || 0} 条链接`, 'success');
  };
  const sync = async () => {
    setBusy(true);
    try { await synchronize(); }
    catch (error: any) { toast(error.message || '同步失败', 'error'); await resource.reload(); }
    finally { setBusy(false); }
  };
  if (resource.loading && !data) return <LoadingState />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (!data) return null;
  return <Card title={<span className="integration-title"><Link2 size={25} aria-hidden="true" />链接库</span>} className="integration-links-card" description="发送链接卡片时可按关键词查找预设链接。" action={<Badge>{(data.count || 0).toLocaleString()} 条链接</Badge>}>
    <div className="integration-links-layout"><div><StatusRow label="数据来源">{data.source === 'remote' ? '远端下发' : data.source === 'user' ? '本地缓存' : '程序内置'}</StatusRow><CopyValue label="同步地址" value={data.remoteUrl} /><StatusRow label="上次同步">{timeLabel(data.lastSyncAt)}</StatusRow></div>
    <section className="integration-section"><h3>同步管理</h3><Toggle label="每 6 小时自动同步" checked={data.auto !== false} disabled={busy} onChange={async (enabled) => {
      setBusy(true);
      try { await post('/api/links/auto', { auto: enabled }); await resource.reload(); toast(enabled ? '已开启自动同步' : '已关闭自动同步', 'success'); if (enabled) await synchronize(); }
      catch (error: any) { toast(error.message || '更新失败', 'error'); await resource.reload(); }
      finally { setBusy(false); }
    }} /><p className="muted integration-note">关闭自动同步后，仍可随时手动更新。</p><div className="action-row integration-card-actions"><Button loading={busy} onClick={sync}><RefreshCw size={19} className={busy ? 'spin' : ''} />{busy ? '同步中…' : '立即同步'}</Button></div></section></div>
    {data.lastError && <p className="integration-error" role="alert">最近同步失败：{data.lastError}</p>}
    {data.manualHold && <p className="muted integration-note">本地缓存已手动修改，立即同步会使用远端内容覆盖。</p>}
    <p className="muted integration-note">列表由{data.remoteFromEnv ? '云端平台' : '官方链接库'}统一维护，数据地址只读。关闭自动同步后仍可手动同步。</p>
  </Card>;
}

export function AppearancePanel() {
  const { theme, setTheme } = useApp();
  const resource = useResource(() => api('/api/ui/background'));
  const data: any = resource.data;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const save = async (background: string | null) => {
    setBusy(true);
    try {
      const result: any = await post('/api/ui/background', { background });
      window.dispatchEvent(new CustomEvent('jz:background', { detail: result.background || null }));
      await resource.reload(); toast(background ? '背景已更新' : '背景已清除', 'success');
    } catch (error: any) { toast(error.message || '更新背景失败', 'error'); }
    finally { setBusy(false); }
  };
  const upload = async (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast('请选择图片文件', 'error'); return; }
    if (file.size > 5 * 1024 * 1024) { toast('图片请控制在 5 MB 以内', 'error'); return; }
    setBusy(true);
    try {
      const result = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取图片')); reader.readAsDataURL(file); });
      await save(result);
    } catch (error: any) { toast(error.message || '上传失败', 'error'); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ''; }
  };
  return <div className="integration-appearance-layout"><Card title="界面主题" className="integration-theme-card" description="默认使用深色，也可以切换到浅色。">
    <div className="integration-theme-options" role="group" aria-label="界面主题">
      <Button variant="ghost" size="icon" aria-label="深色主题" title="深色主题" aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}><Moon size={19} aria-hidden="true" /></Button>
      <Button variant="ghost" size="icon" aria-label="浅色主题" title="浅色主题" aria-pressed={theme === 'light'} onClick={() => setTheme('light')}><Sun size={19} aria-hidden="true" /></Button>
    </div>
  </Card>
    <Card title="自定义背景" className="integration-background-card" description="使用图片地址或上传本地图片，设置会保存到当前服务。" action={<span className="integration-card-icon"><Image size={22} aria-hidden="true" /></span>}>
      {resource.loading && !data ? <LoadingState /> : resource.error ? <ErrorState error={resource.error} onRetry={resource.reload} /> : <>
        <StatusRow label="当前背景">{data?.background ? String(data.background).startsWith('data:') ? '上传的图片' : '图片地址' : '默认背景'}</StatusRow>
        {data?.background && <div className="integration-background-preview"><img src={data.background} alt="当前自定义背景" /></div>}
        <form className="stack" onSubmit={(event) => { event.preventDefault(); const next = url.trim(); if (!next) { toast('请输入图片地址', 'error'); return; } if (!/^https?:\/\//i.test(next)) { toast('图片地址应以 http:// 或 https:// 开头', 'error'); return; } save(next); }}>
          <Field label="图片地址"><Input type="url" disabled={busy} placeholder="https://example.com/background.jpg" value={url} onChange={(event) => setUrl(event.target.value)} /></Field>
          <div className="action-row"><Button type="submit" disabled={busy}>{busy ? '保存中…' : '应用地址'}</Button><Button type="button" variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}><Upload size={16} />上传图片</Button><Button type="button" variant="ghost" disabled={busy || !data?.background} onClick={() => save(null)}>恢复默认背景</Button></div>
        </form><input ref={fileInput} type="file" accept="image/*" hidden onChange={(event) => upload(event.target.files?.[0])} /><p className="muted integration-note">支持常见图片格式，单张不超过 5 MB。</p>
      </>}
    </Card>
  </div>;
}
