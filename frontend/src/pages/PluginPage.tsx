import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Puzzle, RotateCw, Settings } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui';
import '../components/extensions/extensions.css';

export default function PluginPage() {
  const { params, theme, navigate } = useApp();
  const id = String(params?.id || '');
  const { data, loading, error, reload } = useResource<any>((signal) => api('/api/plugins', { signal }), [id]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(540);
  const [revision, setRevision] = useState(0);
  const plugin = (data?.list || []).find((entry: any) => String(entry.id) === id);

  function syncTheme() {
    const resolved = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    try {
      const root = frameRef.current?.contentDocument?.documentElement;
      if (root) {
        root.setAttribute('data-theme', resolved);
        root.classList.toggle('dark', resolved === 'dark');
        root.style.colorScheme = resolved;
      }
    } catch { /* A plugin may navigate to another origin. */ }
  }

  useEffect(() => {
    setHeight(540);
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== location.origin) return;
      const next = Number(event.data?.__jzPluginHeight);
      if (Number.isFinite(next) && next > 0) setHeight(Math.max(360, Math.min(next, 20000)));
    };
    window.addEventListener('message', onMessage);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    return () => { window.removeEventListener('message', onMessage); observer.disconnect(); };
  }, [id]);
  useEffect(syncTheme, [theme, id]);

  return <div className="stack extensions-page extension-plugin-page">
    <PageHeader title={plugin?.name || '插件界面'} description={plugin?.description || '运行在独立页面中的插件。'} actions={<><Button variant="secondary" onClick={() => navigate('plugins')}><ArrowLeft size={18} />插件管理</Button><Button variant="ghost" size="icon" title="刷新插件界面" aria-label="刷新插件界面" onClick={() => { reload(); setRevision((value) => value + 1); }}><RotateCw size={19} /></Button></>} />
    {loading && !data ? <div className="extension-loading" role="status" aria-label="正在读取插件界面"><span className="sr-only">正在读取插件界面…</span><Skeleton className="extension-loading-frame" /></div> : error ? <ErrorState error={error} onRetry={reload} /> : !plugin ? <EmptyState title="未找到这个插件" description="它可能已经被卸载，或插件系统已关闭。" action={<Button onClick={() => navigate('plugins')}>前往插件管理</Button>} /> : !plugin.loaded || plugin.disabled || !plugin.hasUi ? <EmptyState title={plugin.hasUi ? '插件尚未运行' : '插件没有独立界面'} description={plugin.error || '在插件管理中检查状态和配置。'} action={<Button onClick={() => navigate('plugins')}><Settings size={18} />管理插件</Button>} /> : <section className="extension-plugin-host" aria-label={plugin.name + '独立界面'}><div className="extension-plugin-host-bar"><span><Puzzle size={19} strokeWidth={1.7} aria-hidden="true" />独立插件界面</span><span className="extension-host-version">v{plugin.version || '—'}{plugin.author ? ` · ${plugin.author}` : ''}</span><Badge tone="success">运行中</Badge></div><iframe key={id + ':' + revision} ref={frameRef} className="extension-frame" title={plugin.name} src={'/api/plugin/' + encodeURIComponent(id) + '/ui/'} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" onLoad={syncTheme} style={{ height }} /></section>}
  </div>;
}
