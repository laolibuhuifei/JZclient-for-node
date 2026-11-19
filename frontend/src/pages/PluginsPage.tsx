import React, { useRef, useState } from 'react';
import { ExternalLink, FolderOpen, Puzzle, RotateCw, Scan, Settings, Trash2, Upload } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Select, Skeleton, Textarea, Toggle, toast } from '../components/ui';
import { errorText, externalUrl } from '../components/extensions/utils';
import '../components/extensions/extensions.css';

const permissions: Record<string, string> = {
  'chat.send': '发送消息', 'chat.read': '读取聊天', 'watch.read': '读取手表',
  'watch.write': '修改手表', http: '访问网络',
};

export default function PluginsPage() {
  const { navigate, refreshAll } = useApp();
  const { data, loading, error, reload } = useResource<any>((signal) => api('/api/plugins', { signal }), []);
  const [busy, setBusy] = useState('');
  const busyRef = useRef(false);
  const [configPlugin, setConfigPlugin] = useState<any>(null);
  const [values, setValues] = useState<Record<string, any>>({});
  const [uninstallPlugin, setUninstallPlugin] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const list: any[] = data?.list || [];
  const enabled = data?.enabled !== false;
  const managed = data?.mode === 'managed';
  const marketUrl = externalUrl(data?.consoleUrl);
  const runningCount = list.filter((plugin) => plugin.loaded && !plugin.disabled).length;

  async function refresh() {
    await reload();
    await refreshAll();
  }

  async function run(key: string, task: () => Promise<any>, message: string) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      await task();
      toast(message, 'success');
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      try { await refresh(); }
      catch (err) { toast(errorText(err), 'error'); }
      finally { busyRef.current = false; setBusy(''); }
    }
  }

  function openConfig(plugin: any) {
    const draft: Record<string, any> = {};
    for (const field of plugin.config || []) draft[field.key] = plugin.configValues?.[field.key] ?? field.default ?? (field.type === 'boolean' ? false : '');
    setValues(draft);
    setConfigPlugin(plugin);
  }

  async function upload(file?: File) {
    if (!file || busyRef.current) return;
    if (!/\.zip$/i.test(file.name)) { toast('请选择 .zip 格式的插件包', 'error'); return; }
    if (file.size > 16 * 1024 * 1024) { toast('插件包大小不能超过 16MB', 'error'); return; }
    busyRef.current = true;
    setBusy('upload');
    try {
      const response = await api('/api/plugins/upload?name=' + encodeURIComponent(file.name), {
        method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: 90000,
      });
      const result = response?.result || {};
      toast(result.loaded ? `已安装 ${result.name || file.name}${result.version ? ' v' + result.version : ''}${result.shadowed ? '，已覆盖同名内置版本' : ''}` : `已安装，但加载失败：${result.error || '未知原因'}`, result.loaded ? 'success' : 'error');
      await refresh();
    } catch (err) { toast(errorText(err), 'error'); }
    finally { busyRef.current = false; setBusy(''); if (fileRef.current) fileRef.current.value = ''; }
  }

  return <div className="stack extensions-page extension-plugins-page">
    <PageHeader title="插件管理" description="安装、配置和管理手表的扩展能力。" actions={<Button variant="secondary" onClick={() => reload()} disabled={!!busy}><RotateCw size={18} />刷新</Button>} />
    {loading && !data ? <div className="extension-loading" role="status" aria-label="正在读取插件"><span className="sr-only">正在读取插件…</span><Skeleton className="extension-loading-system" /><div className="extension-plugin-grid"><Skeleton /><Skeleton /></div></div> : error && !data ? <ErrorState error={error} onRetry={reload} /> : <>
      <Card className="extension-system-card">
        <div className="extension-system-grid">
          <div className="extension-system-overview">
            <div className="extension-system-heading"><span className="extension-system-icon" aria-hidden="true"><Puzzle size={25} strokeWidth={1.7} /></span><div><h2>插件系统</h2><p className="muted">关闭后，插件及其定时任务都会停止。</p></div></div>
            <div className="extension-summary"><Badge tone={enabled ? 'success' : 'neutral'}>{enabled ? '已开启' : '已关闭'}</Badge><span>{runningCount} 个运行中 · {list.length} 个已安装</span></div>
            <Toggle label="启用插件系统" checked={enabled} disabled={!!busy} onChange={(checked) => run('toggle', () => post('/api/plugins/toggle', { enabled: checked }), checked ? '插件系统已开启' : '插件系统已关闭')} />
          </div>
          <div className="extension-install-section">
            <h3>{managed ? '插件市场' : '安装与发现'}</h3>
            {managed ? <><p className="muted">插件由云端平台统一提供。安装后，可以在这里配置和启停。</p>{marketUrl && <a className="button button-secondary extension-market-link" href={marketUrl} target="_blank" rel="noopener noreferrer">打开插件市场 <ExternalLink size={18} /></a>}</> : <>
              <p className="muted">上传 ZIP 插件包，或扫描本地插件目录。</p>
              <div className="action-row"><Button disabled={!!busy} loading={busy === 'upload'} onClick={() => fileRef.current?.click()}><Upload size={18} />{busy === 'upload' ? '安装中…' : '安装插件'}</Button><Button variant="secondary" disabled={!!busy} loading={busy === 'rescan'} onClick={() => run('rescan', () => post('/api/plugins/rescan'), '已重新扫描插件目录')}><Scan size={18} />{busy === 'rescan' ? '扫描中…' : '重新扫描'}</Button></div>
              <input ref={fileRef} type="file" accept=".zip,application/zip" hidden onChange={(event) => { upload(event.target.files?.[0]); }} />
              <p className="muted extension-hint">支持 16MB 以内的 ZIP 文件。</p>
              {data?.dirs?.user && <div className="extension-directory"><FolderOpen size={18} aria-hidden="true" /><code>{data.dirs.user}</code></div>}
            </>}
          </div>
        </div>
      </Card>
      {error && <ErrorState error={error} onRetry={reload} />}
      {!list.length ? <Card className="extension-empty-plugins"><EmptyState icon={<Puzzle size={28} strokeWidth={1.7} />} title={enabled ? '还没有插件' : '插件系统已关闭'} description={enabled ? (managed ? '在云端插件市场安装后，回到这里刷新。' : '安装插件包，或放入插件目录后重新扫描。') : '打开上方总开关，即可恢复已安装插件。'} /></Card> : <section className="extension-installed-section" aria-label="已安装插件"><div className="extension-list-heading"><h2>已安装插件</h2><span className="muted">{list.length} 个</span></div><div className="extension-plugin-grid">{list.map((plugin) => {
        const homepage = externalUrl(plugin.homepage);
        return <Card key={plugin.id} className="extension-plugin-card">
          {plugin.hasCover && <img className="extension-cover" src={'/api/plugins/' + encodeURIComponent(plugin.id) + '/cover?v=' + encodeURIComponent(plugin.version || '')} alt="" loading="lazy" onError={(event) => { event.currentTarget.hidden = true; }} />}
          <div className="extension-plugin-heading"><span className="extension-icon" aria-hidden="true"><Puzzle size={23} strokeWidth={1.7} /></span><div><h3>{plugin.name}</h3><p className="muted">v{plugin.version || '—'} · {plugin.author || '匿名作者'}</p></div><Badge tone={plugin.error ? 'danger' : plugin.disabled ? 'warning' : plugin.loaded ? 'success' : 'neutral'}>{plugin.error ? '加载失败' : plugin.disabled ? '已禁用' : plugin.loaded ? '运行中' : '未运行'}</Badge></div>
          {plugin.description && <p className="extension-description">{plugin.description}</p>}
          <div className="extension-tags">{plugin.builtin && <Badge>内置</Badge>}{plugin.managed && <Badge>来自插件市场</Badge>}{plugin.hasUi && <Badge>独立界面</Badge>}{(plugin.permissions || []).map((permission: string) => <Badge key={permission}>{permissions[permission] || permission}</Badge>)}</div>
          {plugin.error && <p className="extension-error" role="status">{plugin.error}</p>}
          <div className="extension-plugin-actions">
            {plugin.hasUi && plugin.loaded && !plugin.disabled && <Button onClick={() => navigate('plugin', { id: plugin.id })}><ExternalLink size={18} />打开界面</Button>}
            {!!plugin.config?.length && <Button variant="secondary" onClick={() => openConfig(plugin)} disabled={!!busy}><Settings size={18} />设置</Button>}
            <div className="extension-plugin-toggle"><Toggle label={<span className="sr-only">启用插件 {plugin.name}</span>} checked={!plugin.disabled} disabled={!!busy || !enabled} onChange={(checked) => { if (enabled) void run(plugin.id + ':toggle', () => post('/api/plugins/' + encodeURIComponent(plugin.id) + '/' + (checked ? 'enable' : 'disable')), checked ? '插件已启用' : '插件已禁用'); }} /></div>
            <Button variant="ghost" size="icon" disabled={!!busy} title={'重载 ' + plugin.name} aria-label={'重载 ' + plugin.name} onClick={() => run(plugin.id + ':reload', () => post('/api/plugins/' + encodeURIComponent(plugin.id) + '/reload'), '插件已重新加载')}><RotateCw size={19} /></Button>
            {!plugin.builtin && <Button variant="ghost" size="icon" className="extension-uninstall-button" disabled={!!busy} title={'卸载 ' + plugin.name} aria-label={'卸载 ' + plugin.name} onClick={() => setUninstallPlugin(plugin)}><Trash2 size={19} /></Button>}
            {homepage && <a className="extension-homepage" href={homepage} target="_blank" rel="noopener noreferrer">主页 <ExternalLink size={15} /></a>}
          </div>
        </Card>;
      })}</div></section>}
    </>}
    <Modal open={!!configPlugin} closeable={!busy} className="extension-config-dialog" onClose={() => { if (!busy) setConfigPlugin(null); }} title={(configPlugin?.name || '插件') + '设置'} description="配置保存后会立即交给插件处理。" footer={<><Button variant="secondary" disabled={!!busy} onClick={() => setConfigPlugin(null)}>取消</Button><Button disabled={!!busy} loading={busy === 'config'} onClick={() => run('config', async () => { await post('/api/plugins/' + encodeURIComponent(configPlugin.id) + '/config', { values }); setConfigPlugin(null); }, '插件设置已保存')}>{busy === 'config' ? '保存中…' : '保存设置'}</Button></>}>
      <div className="extension-config-fields">{(configPlugin?.config || []).map((field: any) => {
        const setValue = (value: any) => setValues((previous) => ({ ...previous, [field.key]: value }));
        const value = values[field.key] ?? '';
        if (field.type === 'boolean') return <div className="field extension-config-wide extension-config-switch" key={field.key}><Toggle checked={!!value} onChange={setValue} label={field.label || field.key} disabled={!!busy} />{field.hint && <span className="field-hint">{field.hint}</span>}</div>;
        return <Field key={field.key} className={field.type === 'textarea' ? 'extension-config-wide' : undefined} label={field.label || field.key} hint={field.hint}>
          {field.type === 'select' ? <Select value={String(value)} onChange={(event) => setValue(event.target.value)} disabled={!!busy}>{(field.options || []).map((option: any) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}</Select> : field.type === 'textarea' ? <Textarea rows={4} value={value} placeholder={field.placeholder} onChange={(event) => setValue(event.target.value)} disabled={!!busy} /> : <Input type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'} value={value} placeholder={field.placeholder} autoComplete={field.type === 'password' ? 'new-password' : 'off'} onChange={(event) => setValue(event.target.value)} disabled={!!busy} />}
        </Field>;
      })}</div>
    </Modal>
    <Modal open={!!uninstallPlugin} closeable={!busy} size="sm" className="extension-confirm-dialog" onClose={() => { if (!busy) setUninstallPlugin(null); }} title={'卸载“' + (uninstallPlugin?.name || '') + '”'} description="插件文件和它保存的数据会一起删除。" footer={<><Button variant="secondary" disabled={!!busy} onClick={() => setUninstallPlugin(null)}>取消</Button><Button variant="danger" disabled={!!busy} loading={busy === 'uninstall'} onClick={() => run('uninstall', async () => { await post('/api/plugins/' + encodeURIComponent(uninstallPlugin.id) + '/uninstall', { confirm: uninstallPlugin.id }); setUninstallPlugin(null); }, '插件已卸载')}>{busy === 'uninstall' ? '卸载中…' : '确认卸载'}</Button></>}><p>如需保留数据，请先备份后再卸载。</p></Modal>
  </div>;
}
