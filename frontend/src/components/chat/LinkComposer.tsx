import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Link2, Search, Send, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, Field, Input, Select, toast } from '../ui';
import { resizeImage } from './model';

type Preset = { name: string; url: string };
type Props = { onSend: (kind: string, extra: any) => Promise<boolean>; onClose: () => void; busy: boolean };
function savedValue(key: string, fallback: any) { try { return JSON.parse(localStorage.getItem(key) || 'null') || fallback; } catch { return fallback; } }
function recentPresets(): Preset[] { const list = savedValue('jz_link_recent', []); return Array.isArray(list) ? list.filter(item => item?.url).slice(0, 8) : []; }

export default function LinkComposer({ onSend, onClose, busy }: Props) {
  const [form, setForm] = useState(() => { const saved = savedValue('jz_link_form', {}); return { url: String(saved.url || ''), title: String(saved.title || ''), appName: String(saved.appName || '') }; });
  const [query, setQuery] = useState('');
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selected, setSelected] = useState('');
  const [meta, setMeta] = useState<any>(null);
  const [searchInfo, setSearchInfo] = useState('');
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(true);
  const [cover, setCover] = useState('');
  const [icon, setIcon] = useState('');
  const [processing, setProcessing] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);
  const iconInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api('/api/links', { signal: controller.signal }).then(setMeta).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setSearchError('');
    const recent = recentPresets();
    if (!query.trim() && recent.length) {
      setPresets(recent);
      setSearchInfo(`最近使用 ${recent.length} 条 · 输入关键词搜索全部链接`);
      setSearching(false);
      return () => controller.abort();
    }
    setSearching(true);
    const timer = window.setTimeout(async () => {
      try {
        const result = await api('/api/links/search?limit=60&q=' + encodeURIComponent(query.trim()), { signal: controller.signal });
        if (controller.signal.aborted) return;
        setPresets(result.items || []);
        setSearchInfo(query.trim() ? `匹配 ${result.matched || 0} 条${result.hasMore ? `，显示前 ${(result.items || []).length} 条` : ''}` : `共 ${result.total || 0} 条，输入关键词搜索`);
      } catch (error: any) {
        if (!controller.signal.aborted) { setSearchError(error.message || '链接库加载失败'); setPresets([]); }
      } finally { if (!controller.signal.aborted) setSearching(false); }
    }, query ? 200 : 0);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query]);

  const groups = useMemo(() => {
    const map = new Map<string, Preset[]>();
    presets.forEach(item => {
      let host = '其他';
      try { host = new URL(item.url).hostname; } catch { /* Keep malformed legacy entries readable. */ }
      map.set(host, [...(map.get(host) || []), item]);
    });
    return [...map.entries()];
  }, [presets]);
  const preview = presets.find(item => item.url === selected);

  function choosePreset(url: string) {
    setSelected(url);
    if (!url) return;
    setForm(value => ({ ...value, url }));
    const item = presets.find(entry => entry.url === url);
    if (item) try { localStorage.setItem('jz_link_recent', JSON.stringify([item, ...recentPresets().filter(entry => entry.url !== url)].slice(0, 8))); } catch { /* Storage may be disabled. */ }
  }

  async function chooseImage(file: File | undefined, isIcon: boolean) {
    if (!file) return;
    if (file.size > (isIcon ? 4 : 8) * 1024 * 1024) { toast(isIcon ? '图标请控制在 4MB 以内' : '封面请控制在 8MB 以内', 'error'); return; }
    setProcessing(true);
    try {
      const data = await resizeImage(file, isIcon ? 96 : 640, isIcon ? 'image/png' : 'image/jpeg', isIcon ? undefined : 0.82);
      if (isIcon) setIcon(data); else setCover(data);
    } catch (error: any) { toast(error.message, 'error'); }
    finally { setProcessing(false); }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const url = form.url.trim();
    try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
    catch { toast('请输入以 http:// 或 https:// 开头的有效链接', 'error'); return; }
    try { localStorage.setItem('jz_link_form', JSON.stringify({ ...form, url })); } catch { /* No persistence required to send. */ }
    if (await onSend('link', { url, desc: form.title.trim(), appName: form.appName.trim(), cover, icon, businessType: 0 })) onClose();
  }

  return <form onSubmit={submit} className="chat-link-form stack">
    <div className="chat-preset-box">
      <Field label="白名单链接库" hint="搜索中文名称或网址，选择后自动填入链接地址。">
        <div className="chat-search"><Search size={20} aria-hidden="true" /><Input aria-label="搜索白名单链接" value={query} onChange={event => setQuery(event.target.value)} placeholder="例如：支付宝、ilisten" disabled={busy} /></div>
      </Field>
      <Select aria-label="选择白名单链接" value={selected} onChange={event => choosePreset(event.target.value)} disabled={searching || busy}>
        <option value="">{searching ? '正在搜索…' : presets.length ? '选择链接' : '没有匹配的链接'}</option>
        {groups.map(([host, items]) => <optgroup label={`${host}（${items.length}）`} key={host}>{items.map((item, index) => <option key={item.url + index} value={item.url}>{item.name} · {item.url}</option>)}</optgroup>)}
      </Select>
      <small className={searchError ? 'chat-error-text' : 'muted'}>{searchError || searchInfo}{meta?.source ? ` · ${meta.source === 'remote' ? '远端下发' : meta.source === 'user' ? '本地缓存' : '程序内置'}` : ''}</small>
      {meta?.lastError && <small className="chat-error-text">上次同步失败：{meta.lastError}</small>}
      {preview && <div className="chat-link-preview"><Link2 size={20} aria-hidden="true" /><div><strong>{preview.name}</strong><div className="chat-link-preview-url">{preview.url}</div></div></div>}
    </div>
    <Field label="链接地址"><Input required type="url" placeholder="https://" value={form.url} onChange={event => setForm({ ...form, url: event.target.value })} disabled={busy} /></Field>
    <div className="form-grid">
      <Field label="标题" hint="留空时显示链接地址"><Input value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} placeholder="为链接取一个名字" disabled={busy} /></Field>
      <Field label="应用名称" hint="留空时使用 jzclient"><Input value={form.appName} onChange={event => setForm({ ...form, appName: event.target.value })} placeholder="jzclient" disabled={busy} /></Field>
    </div>
    <div className="chat-image-pickers">
      <Field label="封面图" hint="留空时自动抓取网页图标；最大 8MB。">
        <div className="chat-image-picker"><div className="chat-cover-preview">{cover ? <img src={cover} alt="链接封面预览" /> : <ImagePlus size={28} aria-hidden="true" />}</div><div className="stack"><Button type="button" variant="secondary" disabled={processing || busy} onClick={() => coverInput.current?.click()}>选择图片</Button>{cover && <Button type="button" variant="ghost" disabled={processing || busy} onClick={() => setCover('')}><X size={18} aria-hidden="true" />清除</Button>}</div></div>
      </Field>
      <Field label="应用图标" hint="保留透明背景；最大 4MB。">
        <div className="chat-image-picker"><img className="chat-app-icon-preview" src={icon || '/assets/icon-180.png'} alt="应用图标预览" /><div className="stack"><Button type="button" variant="secondary" disabled={processing || busy} onClick={() => iconInput.current?.click()}>选择图标</Button>{icon && <Button type="button" variant="ghost" disabled={processing || busy} onClick={() => setIcon('')}>恢复默认</Button>}</div></div>
      </Field>
    </div>
    <input hidden type="file" accept="image/*" ref={coverInput} disabled={processing || busy} onChange={event => { chooseImage(event.target.files?.[0], false); event.target.value = ''; }} />
    <input hidden type="file" accept="image/*" ref={iconInput} disabled={processing || busy} onChange={event => { chooseImage(event.target.files?.[0], true); event.target.value = ''; }} />
    <div className="chat-composer-actions action-row"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || processing} aria-busy={busy || processing}><Send size={18} aria-hidden="true" />{busy ? '发送中…' : processing ? '处理图片中…' : '发送链接'}</Button></div>
  </form>;
}
