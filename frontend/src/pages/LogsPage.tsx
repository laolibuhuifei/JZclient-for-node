import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, FileText, Pause, Play, RotateCw, Search, Trash2 } from 'lucide-react';
import { api, post } from '../lib/api';
import { Badge, Button, Card, EmptyState, ErrorState, Input, LoadingState, PageHeader, Select, Toggle, toast } from '../components/ui';
import { copyText, errorText } from '../components/extensions/utils';
import '../components/extensions/extensions.css';

type LogEntry = { seq: number; t: number; sev: number; tag?: string; cat?: string; text: string };
const LOG_MAX = 600;
const defaultLevels = ['debug', 'info', 'warn', 'error', 'silent'];

function tagName(entry: LogEntry) {
  if (entry.tag === 'HTTP' || entry.tag === 'API') return entry.tag;
  return ({ 10: 'DEBUG', 20: 'INFO', 30: 'WARN', 40: 'ERROR' } as Record<number, string>)[entry.sev] || 'INFO';
}

function logTime(timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(date.getMilliseconds()).padStart(3, '0');
}

export default function LogsPage() {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [level, setLevel] = useState('info');
  const [levels, setLevels] = useState(defaultLevels);
  const [busy, setBusy] = useState('');
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [transport, setTransport] = useState<'connecting' | 'sse' | 'poll'>('connecting');
  const [revision, setRevision] = useState(0);
  const seqRef = useRef(0);
  const pausedRef = useRef(false);
  const resumingRef = useRef(false);
  const resumeBuffer = useRef<LogEntry[]>([]);
  const atBottom = useRef(true);
  const listRef = useRef<HTMLDivElement>(null);

  const append = useCallback((batch: LogEntry[]) => {
    if (!batch?.length) return;
    if (pausedRef.current) {
      if (resumingRef.current) resumeBuffer.current = [...resumeBuffer.current, ...batch].slice(-LOG_MAX);
      return;
    }
    const incoming = batch.filter((entry) => Number(entry.seq) > seqRef.current);
    if (!incoming.length) return;
    seqRef.current = Math.max(seqRef.current, ...incoming.map((entry) => Number(entry.seq)));
    setEntries((previous) => [...previous, ...incoming].slice(-LOG_MAX));
  }, []);

  const reset = useCallback((response: any) => {
    const next: LogEntry[] = Array.isArray(response?.entries) ? response.entries.slice(-LOG_MAX) : [];
    seqRef.current = typeof response?.seq === 'number' ? response.seq : Number(next[next.length - 1]?.seq || 0);
    setEntries(next);
    if (response?.level) setLevel(response.level);
    if (Array.isArray(response?.levels)) setLevels(response.levels);
    atBottom.current = true;
  }, []);

  useEffect(() => {
    let stopped = false;
    let stream: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let polling = false;
    const controller = new AbortController();
    setLoading(true); setError(''); setTransport('connecting');
    async function poll() {
      if (stopped || polling || pausedRef.current) return;
      polling = true;
      try {
        const response = await api('/api/logs?limit=200&since=' + seqRef.current, { signal: controller.signal });
        if (!stopped) { append(response?.entries || []); setError(''); }
      } catch (err) { if (!stopped) setError(errorText(err)); }
      finally { polling = false; }
    }
    function startPolling() {
      if (stopped || pollTimer) return;
      stream?.close(); stream = null;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      setTransport('poll');
      pollTimer = setInterval(poll, 1500);
      poll();
    }
    function startStream() {
      if (!window.EventSource) { startPolling(); return; }
      let received = false;
      try { stream = new EventSource('/api/logs/stream'); }
      catch { startPolling(); return; }
      stream.addEventListener('init', (event: MessageEvent) => {
        received = true;
        if (stopped) return;
        setTransport('sse'); setError('');
        try {
          const response = JSON.parse(event.data);
          if (!pausedRef.current) reset(response);
          if (response?.level) setLevel(response.level);
        } catch { /* Ignore incomplete events and keep the stream available. */ }
      });
      stream.onmessage = (event) => {
        received = true;
        if (stopped) return;
        setTransport('sse');
        try { append([JSON.parse(event.data)]); } catch { /* The next event is independent. */ }
      };
      stream.onerror = () => {
        if (stopped) return;
        if (!received) startPolling();
        else setTransport('connecting');
      };
      fallbackTimer = setTimeout(() => { if (!received) startPolling(); }, 3000);
    }
    (async () => {
      try {
        const response = await api('/api/logs?limit=300', { signal: controller.signal });
        if (stopped) return;
        if (!pausedRef.current) reset(response);
        startStream();
      } catch (err) { if (!stopped) { setError(errorText(err)); startPolling(); } }
      finally { if (!stopped) setLoading(false); }
    })();
    return () => {
      stopped = true; controller.abort(); stream?.close();
      if (pollTimer) clearInterval(pollTimer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [append, reset, revision]);

  const displayed = entries.filter((entry) => (filter === 'all' || tagName(entry) === filter) && (!query.trim() || [entry.cat, entry.text, entry.tag].join(' ').toLowerCase().includes(query.trim().toLowerCase())));
  useEffect(() => {
    if (autoScroll && atBottom.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [entries, query, filter, autoScroll]);
  useEffect(() => {
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('jz:refresh', refresh);
    return () => window.removeEventListener('jz:refresh', refresh);
  }, []);

  async function togglePause() {
    if (!pausedRef.current) { pausedRef.current = true; setPaused(true); return; }
    setBusy('resume'); resumingRef.current = true; resumeBuffer.current = [];
    try {
      reset(await api('/api/logs?limit=300'));
      pausedRef.current = false; setPaused(false);
      append(resumeBuffer.current); setError('');
    } catch (err) { setError(errorText(err)); }
    finally { resumingRef.current = false; resumeBuffer.current = []; setBusy(''); }
  }

  async function changeLevel(next: string) {
    setBusy('level');
    try { const response = await post('/api/logs/level', { level: next }); setLevel(response?.level || next); toast('日志级别已切换', 'success'); }
    catch (err) { toast(errorText(err), 'error'); }
    finally { setBusy(''); }
  }

  async function clear() {
    setBusy('clear');
    try { const response = await api('/api/logs', { method: 'DELETE' }); reset({ entries: [], seq: response?.seq ?? seqRef.current }); toast('日志已清空', 'success'); }
    catch (err) { toast(errorText(err), 'error'); }
    finally { setBusy(''); }
  }

  async function copy() {
    if (!displayed.length) { toast('没有可复制的日志', 'error'); return; }
    try { await copyText(displayed.map((entry) => `${logTime(entry.t)} ${tagName(entry)}${entry.cat ? ' [' + entry.cat + ']' : ''} ${entry.text}`).join('\n')); toast('日志已复制', 'success'); }
    catch (err) { toast(errorText(err), 'error'); }
  }

  return <div className="stack extensions-page extension-logs-page">
    <PageHeader title="实时日志" description="查看服务活动、连接情况和接口执行记录。" actions={<Badge tone={paused ? 'warning' : transport === 'connecting' ? 'neutral' : 'success'}>{paused ? '已暂停显示' : transport === 'sse' ? '实时推送' : transport === 'poll' ? '轮询连接' : '连接中'}</Badge>} />
    <Card className="extension-logs-card">
      <div className="extension-log-toolbar">
        <label className="extension-log-search"><span>搜索日志</span><div><Search size={19} aria-hidden="true" /><Input aria-label="搜索日志" placeholder="搜索内容、模块或标签…" value={query} onChange={(event) => setQuery(event.target.value)} /></div></label>
        <label className="extension-compact-field">输出级别<Select aria-label="日志输出级别" value={level} disabled={!!busy} onChange={(event) => changeLevel(event.target.value)}>{levels.map((entry) => <option key={entry} value={entry}>{entry.toUpperCase()}</option>)}</Select></label>
        <label className="extension-compact-field">显示类型<Select aria-label="日志标签筛选" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部类型</option>{['DEBUG', 'INFO', 'WARN', 'ERROR', 'HTTP', 'API'].map((tag) => <option key={tag} value={tag}>{tag}</option>)}</Select></label>
      </div>
      <div className="extension-log-actions"><div className="extension-log-view-options"><span className="extension-log-count"><FileText size={17} aria-hidden="true" />{displayed.length} / {entries.length} 行</span><Toggle label="自动滚动" checked={autoScroll} onChange={(checked) => { setAutoScroll(checked); if (checked) { atBottom.current = true; if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; } }} /></div><div className="action-row"><Button variant="secondary" disabled={!!busy} loading={busy === 'resume'} onClick={togglePause}>{paused ? <Play size={18} /> : <Pause size={18} />}{paused ? '继续' : '暂停'}</Button><Button variant="ghost" onClick={copy}><Copy size={18} />复制</Button><Button variant="ghost" className="extension-log-clear" disabled={!!busy} onClick={clear}><Trash2 size={18} />清空</Button><Button variant="ghost" size="icon" title="重新连接日志" aria-label="重新连接日志" onClick={() => setRevision((value) => value + 1)}><RotateCw size={19} /></Button></div></div>
      {error && <ErrorState error={error} onRetry={() => setRevision((value) => value + 1)} />}
      <div ref={listRef} className="extension-log-body" role="log" aria-label="服务日志" aria-live="off" tabIndex={0} onScroll={() => { const box = listRef.current; if (box) atBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48; }}>
        {loading && !entries.length ? <LoadingState /> : !displayed.length ? <EmptyState title={query || filter !== 'all' ? '没有符合条件的日志' : '等待新的日志'} description={query || filter !== 'all' ? '试试其他关键词或显示类型。' : level === 'silent' ? '当前输出级别为 SILENT，可在上方调整。' : '服务的新活动会显示在这里。'} /> : displayed.map((entry, index) => <div className={'extension-log-line log-' + tagName(entry).toLowerCase()} key={entry.seq || index}><div className="extension-log-meta"><time>{logTime(entry.t)}</time><span className="extension-log-tag">{tagName(entry)}</span>{entry.cat && <span className="extension-log-category">{entry.cat}</span>}</div><span className="extension-log-text">{entry.text}</span></div>)}
      </div>
      <p className="muted extension-hint">保留最近 600 行。DEBUG 显示接口明细；暂停只停止界面更新，不影响服务运行。日志中的敏感信息由服务端脱敏。</p>
    </Card>
  </div>;
}
