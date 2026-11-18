import React, { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, Check, CheckCircle2, ChevronRight, CircleAlert, ExternalLink, Image, Link2, LoaderCircle, MapPin, MessageCircle, Mic, PlugZap, Plus, RefreshCw, Search, Send, Smile, Type, Users, Video, Watch, XCircle } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { layoutRect, uiScale } from '../lib/displayScale';
import { useResource } from '../lib/hooks';
import { Badge, Button, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, Skeleton, Textarea, toast } from '../components/ui';
import LinkComposer from '../components/chat/LinkComposer';
import MediaComposer from '../components/chat/MediaComposer';
import Recorder from '../components/chat/Recorder';
import { ChatMessage, ChatTarget, IMState, KeyedMessage, fileDataUrl, formatMessageTime, imStateText, reconcileMessages, safeMessageUrl } from '../components/chat/model';
import '../components/chat/chat.css';
import WatchAvatar from '../components/WatchAvatar';
import ChatLocationComposer from '../components/chat/ChatLocationComposer';

type ComposerKind = 'options' | 'emoji' | 'kaomoji' | 'location' | 'link' | 'image' | 'video' | 'voice';
type Composer = { kind: ComposerKind; target: ChatTarget };
const COMPOSER_TITLES: Record<ComposerKind, string> = { options: '发送内容', emoji: '发送表情', kaomoji: '发送颜文字', location: '发送位置', link: '发送链接', image: '发送图片', video: '发送视频', voice: '发送语音' };
const ATTACHMENTS = [
  { kind: 'emoji', label: '表情', icon: Smile }, { kind: 'kaomoji', label: '颜文字', icon: Type },
  { kind: 'voice', label: '语音', icon: Mic }, { kind: 'location', label: '位置', icon: MapPin },
  { kind: 'link', label: '链接', icon: Link2 }, { kind: 'image', label: '图片', icon: Image }, { kind: 'video', label: '视频', icon: Video },
] as const;

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const url = safeMessageUrl(message.url);
  let content: React.ReactNode = <span className="chat-message-text">{message.text || ''}</span>;
  let original = !!url;
  if (url && (message.kind === 'emoji' || message.kind === 'kaomoji')) {
    content = <img className="chat-message-emoji" src={url} alt={message.text || '表情'} title={message.text || '表情'} loading="lazy" />;
    original = false;
  } else if (url && message.kind === 'photo') {
    content = <a href={url} target="_blank" rel="noopener noreferrer"><img className="chat-message-image" src={url} alt="聊天图片，点击查看原图" loading="lazy" /></a>;
  } else if (url && message.kind === 'video') {
    content = <video className="chat-message-video" src={url} controls preload="metadata" />;
  } else if (url && message.kind === 'voice') {
    content = <><audio className="chat-message-audio" src={url} controls preload="metadata" /><span className="chat-media-caption">{message.text}</span></>;
  } else if (url && (message.kind === 'link' || message.kind === 'relay_h5')) {
    content = <a className="chat-message-link" href={url} target="_blank" rel="noopener noreferrer"><span><Link2 size={18} /></span><div>{message.text || url}<small>{url}</small></div><ExternalLink size={14} /></a>;
    original = false;
  } else original = false;
  return <article className={`chat-message ${message.self ? 'is-self' : ''}`} data-kind={message.kind || 'text'}>
    <span className="sr-only">{message.self ? '我：' : '对方：'}</span>
    <div className="chat-message-bubble">{content}{original && <a className="chat-original-file" href={url} target="_blank" rel="noopener noreferrer">打开原文件<ExternalLink size={11} /></a>}</div>
    <time className="chat-message-time">{formatMessageTime(message.time)}{message.self && <><Check size={14} aria-hidden="true" /><span className="sr-only">已发送</span></>}</time>
  </article>;
});

function ConversationLoading() {
  return <div className="chat-list-loading" role="status">
    <span className="sr-only">正在加载会话…</span>
    {[0, 1, 2].map(index => <div className="chat-list-placeholder" key={index} aria-hidden="true"><Skeleton className="chat-avatar-placeholder" /><div><Skeleton /><Skeleton /></div></div>)}
  </div>;
}

function MessagesLoading() {
  return <div className="chat-message-loading" role="status">
    <span className="sr-only">正在同步消息…</span>
    {[0, 1, 2, 3].map(index => <Skeleton className={index % 2 ? 'is-self' : ''} key={index} aria-hidden="true" />)}
  </div>;
}

function EmojiPicker({ onSend, busy, onClose }: { onSend: (kind: string, extra: any) => Promise<boolean>; busy: boolean; onClose: () => void }) {
  const resource = useResource(() => api('/api/chats/emojis'), []);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<number | null>(null);
  const emojis = (resource.data?.emojis || []).filter((entry: any) => `${entry.desc} ${entry.descEn || ''}`.toLowerCase().includes(query.toLowerCase()));
  if (resource.loading && !resource.data) return <LoadingState />;
  if (resource.error && !resource.data) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  return <div className="chat-emoji-picker stack">
    <div className="chat-search"><Search size={20} aria-hidden="true" /><Input aria-label="搜索表情" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索表情" disabled={busy} /></div>
    {emojis.length ? <div className="chat-emoji-grid">{emojis.map((emoji: any) => <button type="button" className={`chat-emoji-button ${pending === emoji.index ? 'is-sending' : ''}`} key={emoji.index} disabled={busy} aria-label={`发送表情：${emoji.desc}`} aria-busy={pending === emoji.index && busy} title={emoji.desc} onClick={async () => { setPending(emoji.index); const success = await onSend('emoji', { index: Number(emoji.index) }); if (success) onClose(); else setPending(null); }}>
      {emoji.url ? <img src={safeMessageUrl(emoji.url)} alt={emoji.desc} loading="lazy" /> : <Smile size={32} />}<span>{emoji.desc}</span>{pending === emoji.index && busy && <LoaderCircle size={14} className="chat-spin" />}
    </button>)}</div> : <EmptyState title="没有匹配的表情" description="换个关键词再试试。" />}
  </div>;
}

function SimpleComposer({ busy, onSend, onClose }: { busy: boolean; onSend: (kind: string, extra: any) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState('');
  return <form className="chat-simple-composer stack" onSubmit={async event => {
    event.preventDefault();
    if (text.trim() && await onSend('kaomoji', { text: text.trim() })) onClose();
  }}>
    <Field label="颜文字内容"><Input required value={text} onChange={event => setText(event.target.value)} placeholder="(・ω・)" autoFocus disabled={busy} /></Field>
    <div className="chat-composer-actions action-row"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || !text.trim()} aria-busy={busy}><Send size={18} aria-hidden="true" />{busy ? '发送中…' : '发送颜文字'}</Button></div>
  </form>;
}

export default function ChatPage() {
  const { account, navigate, params, watches = [], loading: appLoading, tokenInvalid } = useApp();
  const [selected, setSelected] = useState<string>(() => String(params?.key || ''));
  const [query, setQuery] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [composer, setComposer] = useState<Composer | null>(null);
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [messageState, setMessageState] = useState<{ key: string; rows: KeyedMessage[] }>({ key: '', rows: [] });
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [messageError, setMessageError] = useState('');
  const [sendError, setSendError] = useState('');
  const [messageIM, setMessageIM] = useState<IMState | null>(null);
  const [showJump, setShowJump] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const messageBox = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const keyCounter = useRef(0);
  const sending = useRef(false);
  const alive = useRef(true);
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const messagesReload = useRef<() => Promise<void>>(async () => {});
  const targetsResource = useResource((signal?: AbortSignal) => appLoading || !account?.loggedIn || tokenInvalid ? Promise.resolve({ targets: [], im: null, unavailable: true }) : api('/api/chats', { signal }), [account?.loggedIn, account?.userName, appLoading, tokenInvalid], 30000);
  const targets: ChatTarget[] = targetsResource.data?.targets || [];
  // Older servers omit device IDs from chat targets. Match the actual IM account
  // from the existing profile API, never a nickname that two children may share.
  const watchIdentityKey = watches.map(watch => String(watch.watchId)).join('|');
  const identities = useResource(async (signal: AbortSignal) => {
    if (!account?.loggedIn || tokenInvalid) return {};
    const entries = await Promise.all(watches.map(async watch => {
      try {
        const profile = await api(`/api/watch/${encodeURIComponent(watch.watchId)}/profile`, { signal });
        return profile?.account?.imAccountId ? [`s:${profile.account.imAccountId}`, String(watch.watchId)] : null;
      } catch { return null; }
    }));
    return Object.fromEntries(entries.filter((entry): entry is string[] => !!entry));
  }, [watchIdentityKey, account?.loggedIn, tokenInvalid]);
  const avatarFor = (item: ChatTarget) => item.watchId || identities.data?.[item.key];
  const conversationAvatar = (item: ChatTarget) => item.type === 'group' ? <span className="chat-target-avatar" aria-hidden="true"><Users size={23} /></span> : <WatchAvatar watchId={avatarFor(item)} chatKey={item.key} url={item.avatarUrl} name={item.name} className="chat-target-avatar" />;
  const target = targets.find(item => item.key === selected) || null;
  const filteredTargets = targets.filter(item => `${item.name} ${item.sub || ''}`.toLowerCase().includes(query.toLowerCase()));
  const messages = messageState.key === selected ? messageState.rows : [];
  const im: IMState | null = messageIM || targetsResource.data?.im || null;
  const imReady = !!im?.connected && !!im?.alive;
  const connectionLabel = !im ? '状态获取中' : !im.connected ? '未连接' : !im.alive ? '正在重连' : '已连接';
  const imBad = !!im && (!im.connected || !im.alive || (im.lastRecvAgo != null && im.lastRecvAgo > 300));
  const draft = drafts[selected] || '';

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { setSelected(String(params?.key || '')); }, [params?.key]);
  useEffect(() => {
    if (!appLoading && account?.loggedIn && !tokenInvalid && targetsResource.data && !targetsResource.data.unavailable && selected && !targets.some(item => item.key === selected)) {
      setSelected('');
      navigate('chat');
    }
  }, [targetsResource.data, selected, appLoading, account?.loggedIn, tokenInvalid]);

  useLayoutEffect(() => {
    const element = workspaceRef.current;
    if (!element || appLoading || !account?.loggedIn || tokenInvalid) return;
    const workspace = element;
    const conversationKey = target?.key;
    const narrowScreen = window.matchMedia?.('(max-width: 767px)');
    const viewport = window.visualViewport;
    const shell = workspace.closest<HTMLElement>('.app-shell');
    const header = shell?.querySelector<HTMLElement>('.app-header');
    const navigation = shell?.querySelector<HTMLElement>('.floating-dock');
    const main = workspace.closest('main');
    let frame = 0;
    let alignFrame = 0;
    let bottomFrame = 0;
    let lastHeight = Number.NaN;

    function measure(alignConversation = false) {
      if (!narrowScreen?.matches) {
        workspace.style.removeProperty('--chat-mobile-height');
        shell?.style.removeProperty('--chat-viewport-height');
        shell?.style.removeProperty('--chat-viewport-top');
        workspace.removeAttribute('data-compact');
        lastHeight = Number.NaN;
        return;
      }
      // All bounds use CSS pixels in the visible viewport, including keyboard resizing.
      const scale = uiScale();
      const viewportTop = (viewport?.offsetTop || 0) / scale;
      const viewportBottom = viewportTop + (viewport?.height || window.innerHeight) / scale;
      if (conversationKey) {
        // A phone conversation is a full page. The keyboard's visual viewport
        // supplies its height; global chrome and document scrolling take no space.
        const height = Math.floor(viewportBottom - viewportTop);
        shell?.style.setProperty('--chat-viewport-height', `${height}px`);
        shell?.style.setProperty('--chat-viewport-top', `${viewportTop}px`);
        workspace.style.setProperty('--chat-mobile-height', `${height}px`);
        workspace.dataset.compact = String(height < 440);
        if (height !== lastHeight) {
          lastHeight = height;
          window.cancelAnimationFrame(bottomFrame);
          bottomFrame = window.requestAnimationFrame(() => {
            if (nearBottom.current && messageBox.current) messageBox.current.scrollTop = messageBox.current.scrollHeight;
          });
        }
        return;
      }
      const workspaceBounds = layoutRect(workspace);
      const headerBounds = header ? layoutRect(header) : null;
      const headerPosition = header ? getComputedStyle(header).position : '';
      const visibleHeader = headerBounds && ['sticky', 'fixed'].includes(headerPosition) && headerBounds.bottom > viewportTop && headerBounds.top < viewportBottom;
      const anchorTop = Math.max(viewportTop, visibleHeader ? headerBounds.bottom : viewportTop) + 12;
      const navigationBounds = navigation ? layoutRect(navigation) : null;
      const visibleNavigation = navigationBounds && getComputedStyle(navigation!).position === 'fixed' && navigationBounds.bottom > viewportTop && navigationBounds.top < viewportBottom && navigationBounds.right > workspaceBounds.left && navigationBounds.left < workspaceBounds.right;
      const safeBottom = parseFloat(getComputedStyle(workspace).getPropertyValue('--chat-safe-bottom')) || 0;
      const usableBottom = (visibleNavigation ? Math.min(viewportBottom, navigationBounds.top) : navigation ? viewportBottom : viewportBottom - 76 - safeBottom) - 12;
      const usableTop = alignConversation ? anchorTop : Math.max(anchorTop, workspaceBounds.top);
      const height = Math.max(0, Math.floor(usableBottom - usableTop));
      const pageScroll = window.scrollY;

      if (!Number.isFinite(lastHeight) || Math.abs(lastHeight - height) >= 1) {
        workspace.style.setProperty('--chat-mobile-height', `${height}px`);
        workspace.dataset.compact = String(height < 380);
        lastHeight = height;
        window.cancelAnimationFrame(bottomFrame);
        bottomFrame = window.requestAnimationFrame(() => {
          if (nearBottom.current && messageBox.current) messageBox.current.scrollTop = messageBox.current.scrollHeight;
        });
      }
      if (alignConversation && Math.abs(workspaceBounds.top - anchorTop) >= 1) {
        // Reserve the full height first, so the document has enough scroll range.
        window.scrollTo({ top: Math.max(0, pageScroll + (workspaceBounds.top - anchorTop) * scale), behavior: 'auto' });
        scheduleMeasure();
      }
    }

    function scheduleMeasure() {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => measure());
    }

    function scheduleAlignment() {
      if (!conversationKey) return;
      window.cancelAnimationFrame(alignFrame);
      alignFrame = window.requestAnimationFrame(() => measure(true));
    }

    function alignChangedRoute() {
      const [path, query = ''] = window.location.hash.slice(1).split('?');
      if (path === '/chat' && new URLSearchParams(query).get('key') === conversationKey) scheduleAlignment();
    }

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleMeasure);
    function observeLayout() {
      observer?.disconnect();
      const precedingContent = Array.from(main?.children || []).filter(element => !element.contains(workspace));
      [header, navigation, workspace.previousElementSibling, ...precedingContent].forEach(element => { if (element) observer?.observe(element); });
    }
    observeLayout();
    const contentObserver = typeof MutationObserver === 'undefined' || !main ? null : new MutationObserver(() => { observeLayout(); scheduleMeasure(); });
    contentObserver?.observe(main!, { childList: true });
    window.addEventListener('resize', scheduleMeasure);
    window.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('hashchange', alignChangedRoute);
    viewport?.addEventListener('resize', scheduleMeasure);
    viewport?.addEventListener('scroll', scheduleMeasure);
    narrowScreen?.addEventListener('change', scheduleMeasure);
    measure();
    scheduleAlignment();
    // Route entrance uses a short transform; its final position only needs measuring.
    const settleTimer = window.setTimeout(scheduleMeasure, 220);
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(alignFrame);
      window.cancelAnimationFrame(bottomFrame);
      window.clearTimeout(settleTimer);
      observer?.disconnect();
      contentObserver?.disconnect();
      window.removeEventListener('resize', scheduleMeasure);
      window.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('hashchange', alignChangedRoute);
      viewport?.removeEventListener('resize', scheduleMeasure);
      viewport?.removeEventListener('scroll', scheduleMeasure);
      narrowScreen?.removeEventListener('change', scheduleMeasure);
      shell?.style.removeProperty('--chat-viewport-height');
      shell?.style.removeProperty('--chat-viewport-top');
    };
  }, [target?.key, appLoading, account?.loggedIn, tokenInvalid]);

  useEffect(() => {
    setMessageError(''); setSendError(''); setMessageIM(null); setShowJump(false);
    setMessageState({ key: selected, rows: [] });
    nearBottom.current = true;
    if (!selected || appLoading || !account?.loggedIn || tokenInvalid) { setMessagesLoading(false); return; }
    const controller = new AbortController();
    let inFlight = false;
    setMessagesLoading(true);
    async function refreshMessages() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const result = await api('/api/chats/messages?key=' + encodeURIComponent(selected), { signal: controller.signal, timeoutMs: 15000 });
        if (controller.signal.aborted) return;
        setMessageState(previous => ({ key: selected, rows: reconcileMessages(previous.key === selected ? previous.rows : [], result.messages || [], () => `message-${++keyCounter.current}`) }));
        setMessageIM(result.im || null);
        setMessageError('');
      } catch (error: any) { if (!controller.signal.aborted) setMessageError(error.message || '消息同步失败'); }
      finally { inFlight = false; if (!controller.signal.aborted) setMessagesLoading(false); }
    }
    messagesReload.current = refreshMessages;
    refreshMessages();
    const refreshIfVisible = () => { if (!document.hidden) refreshMessages(); };
    const timer = window.setInterval(refreshIfVisible, 3000);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshIfVisible); messagesReload.current = async () => {}; };
  }, [selected, appLoading, account?.loggedIn, tokenInvalid]);

  useLayoutEffect(() => {
    const box = messageBox.current;
    if (box && nearBottom.current) box.scrollTop = box.scrollHeight;
  }, [messages]);

  async function perform(request: () => Promise<any>, targetKey: string): Promise<boolean> {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true); setSendError('');
    try {
      const result = await request();
      if (alive.current) {
        if (selectedRef.current === targetKey) {
          nearBottom.current = true;
          await messagesReload.current();
        }
        targetsResource.reload();
        if (result?.parts > 1) toast(`已分成 ${result.parts} 段发送`, 'success');
      }
      return true;
    } catch (error: any) {
      if (alive.current) { setSendError(error.message || '发送失败'); toast(error.message || '发送失败', 'error'); }
      return false;
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  }

  const send = (kind: string, extra: any, destination = composer?.target.key || selected) => perform(() => api('/api/chats/send', { method: 'POST', body: { key: destination, kind, ...extra }, timeoutMs: 300000 }), destination);
  const closeComposer = () => { if (!sending.current) setComposer(null); };

  async function submitText(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft.trim(); const destination = selected;
    if (!text || !target || busy) return;
    if (await send('text', { text }, destination)) setDrafts(current => ({ ...current, [destination]: current[destination]?.trim() === text ? '' : current[destination] }));
  }

  async function connect() {
    setConnecting(true);
    try { await api('/api/chats/connect', { method: 'POST' }); toast('IM 已连接', 'success'); await targetsResource.reload(); await messagesReload.current(); }
    catch (error: any) { toast(error.message, 'error'); }
    finally { if (alive.current) setConnecting(false); }
  }

  if (appLoading) return <LoadingState />;
  if (!account?.loggedIn || tokenInvalid) return <div className="chat-page stack"><PageHeader title="聊天" description="与手表和家庭群保持联系" /><EmptyState title={tokenInvalid ? '登录状态已失效' : '登录后开始聊天'} description="登录家长端账号后，这里会显示手表单聊和家庭群。" icon={<MessageCircle size={28} />} action={<Button onClick={() => navigate('account')}>登录账号<ChevronRight size={18} /></Button>} /></div>;

  return <div className="chat-page stack">
    <PageHeader title="聊天" titleAccessory={<span className={`chat-heading-status ${imReady ? 'is-online' : 'is-offline'}`} role="status" title={imStateText(im)}><span>IM {connectionLabel}</span>{imReady ? <CheckCircle2 size={13} aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}</span>} description="与手表和家庭群保持联系" actions={<><Button variant="ghost" size="icon" disabled={connecting} aria-busy={connecting} onClick={connect} aria-label="重新连接 IM" title="重新连接 IM">{connecting ? <LoaderCircle size={20} className="chat-spin" /> : <PlugZap size={21} />}</Button><Button variant="ghost" size="icon" disabled={targetsResource.loading || messagesLoading} aria-busy={targetsResource.loading || messagesLoading} onClick={() => { targetsResource.reload(); messagesReload.current(); }} aria-label="刷新会话" title="刷新会话"><RefreshCw size={20} aria-hidden="true" /></Button></>} />
    <div className={`chat-workspace ${target ? 'has-selection' : ''}`} ref={workspaceRef}>
      <aside className="chat-sidebar" aria-label="会话列表">
        <div className="chat-sidebar-toolbar"><div className="chat-sidebar-heading"><h2>全部会话</h2><Badge aria-label={`${targets.length} 个会话`}>{targets.length}</Badge></div>
        <div className="chat-search chat-conversation-search"><Search size={18} aria-hidden="true" /><Input aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} /></div></div>
        <div className="chat-target-list">
          {targetsResource.loading && !targetsResource.data ? <ConversationLoading /> : targetsResource.error && !targets.length ? <ErrorState error={targetsResource.error} onRetry={targetsResource.reload} /> : !filteredTargets.length ? <EmptyState title={targets.length ? '没有匹配的会话' : '暂无会话'} description={targets.length ? '试试其他关键词。' : '绑定手表后刷新会话列表。'} action={targets.length ? <Button variant="ghost" onClick={() => setQuery('')}>清除搜索</Button> : <Button variant="ghost" onClick={() => navigate('bind')}>绑定手表</Button>} /> : filteredTargets.map(item => <button type="button" key={item.key} className={`chat-target ${selected === item.key ? 'is-active' : ''}`} onClick={() => { setSelected(item.key); navigate('chat', { key: item.key }); }} aria-pressed={selected === item.key} title={item.name || '未命名会话'}>
            {conversationAvatar(item)}<span className="chat-target-copy"><strong>{item.name || '未命名会话'}</strong><small>{item.sub || (item.type === 'group' ? '家庭群' : '单聊')}</small></span>{!!item.count && <span className="chat-message-count" aria-label={`${item.count} 条消息`}>{item.count}</span>}
          </button>)}
        </div>
        {targetsResource.error && !!targets.length && <div className="chat-sidebar-notice" role="status"><CircleAlert size={18} aria-hidden="true" /><span>会话列表未更新，刷新后重试。</span></div>}
      </aside>
      <section className="chat-thread" aria-label={target ? `${target.name}的聊天` : '聊天内容'}>
        {!target ? <div className="chat-welcome"><span className="chat-welcome-icon"><MessageCircle size={36} strokeWidth={1.5} /></span><h2>从一段对话开始</h2><p>选择会话，发送文字、图片或语音。</p><div className="chat-welcome-types"><span><Watch size={15} />手表单聊</span><span><Users size={15} />家庭群聊</span></div></div> : <>
          <header className="chat-thread-header"><Button className="chat-back-button" size="icon" variant="ghost" aria-label="返回会话列表" onClick={() => { setSelected(''); navigate('chat'); }}><ArrowLeft size={22} /></Button>{conversationAvatar(target)}<div className="chat-thread-heading"><h2 title={target.name}>{target.name}</h2><p title={target.sub}>{target.sub || (target.type === 'group' ? '家庭群' : '单聊')}</p><span className={`chat-heading-status chat-thread-status ${imReady ? 'is-online' : 'is-offline'}`} role="status"><span>IM {connectionLabel}</span>{imReady ? <CheckCircle2 size={13} aria-hidden="true" /> : <XCircle size={13} aria-hidden="true" />}</span></div></header>
          {imBad && <div className="chat-inline-notice" role="status"><CircleAlert size={18} aria-hidden="true" /><span>{imStateText(im)}</span><Button type="button" variant="ghost" disabled={connecting} aria-busy={connecting} onClick={connect}>重新连接</Button></div>}
          <div className="chat-messages-container">
            <div className="chat-messages" ref={messageBox} role="log" aria-label="聊天消息" aria-live="polite" aria-relevant="additions" aria-busy={messagesLoading} onScroll={() => { const box = messageBox.current; if (!box) return; nearBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80; setShowJump(!nearBottom.current); }} onLoad={() => { if (nearBottom.current && messageBox.current) messageBox.current.scrollTop = messageBox.current.scrollHeight; }}>
              {messagesLoading && !messages.length ? <MessagesLoading /> : !messages.length && !messageError ? <div className="chat-no-messages"><MessageCircle size={30} aria-hidden="true" /><span>还没有消息</span><small>在下方发送一句问候，开启这段对话。</small></div> : messages.map(item => <MessageBubble key={item.key} message={item.message} />)}
            </div>
            {showJump && <Button className="chat-jump-bottom" variant="secondary" type="button" onClick={() => { nearBottom.current = true; setShowJump(false); messageBox.current?.scrollTo({ top: messageBox.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); }}><ArrowDown size={18} aria-hidden="true" />回到最新消息</Button>}
          </div>
          {(messageError || sendError) && <div className="chat-inline-notice is-error" role="alert"><CircleAlert size={18} aria-hidden="true" /><span>{sendError || `同步失败：${messageError}`}</span>{messageError && <Button type="button" variant="ghost" onClick={() => messagesReload.current()}>重试</Button>}</div>}
          <form className="chat-compose" onSubmit={submitText}>
            <div className="chat-compose-tools"><div className="chat-compose-attachments" role="group" aria-label="添加消息内容">{ATTACHMENTS.filter(item => ['emoji', 'image', 'voice', 'link'].includes(item.kind)).map(item => <Button variant="ghost" size="icon" type="button" key={item.kind} aria-label={`发送${item.label}`} title={`发送${item.label}`} disabled={busy} onClick={() => setComposer({ kind: item.kind, target })}><item.icon size={22} aria-hidden="true" /></Button>)}<Button variant="ghost" size="icon" type="button" aria-label="更多发送方式" title="更多发送方式" disabled={busy} onClick={() => setComposer({ kind: 'options', target })}><Plus size={22} aria-hidden="true" /></Button></div><span className="chat-compose-tip">Enter 发送 · Shift + Enter 换行</span></div>
            <div className="chat-compose-bottom"><Textarea value={draft} onChange={event => setDrafts(current => ({ ...current, [selected]: event.target.value }))} placeholder={`发送消息给${target.name}…`} aria-label="消息内容" rows={2} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); submitText(); } }} /><Button className="chat-send-button" type="submit" disabled={busy || !draft.trim()} aria-label={busy ? '正在发送消息' : '发送消息'} aria-busy={busy}>{busy ? <LoaderCircle size={21} className="chat-spin" /> : <Send size={21} aria-hidden="true" />}<span>{busy ? '发送中' : '发送'}</span></Button></div>
          </form>
        </>}
      </section>
    </div>
    <Modal className={`chat-composer-dialog${composer?.kind === 'location' ? ' chat-location-dialog' : ''}`} open={!!composer} closeable={!busy} onClose={closeComposer} title={composer ? COMPOSER_TITLES[composer.kind] : ''} description={composer ? <span className="chat-composer-recipient">{conversationAvatar(composer.target)}<span>发送至 {composer.target.name}</span></span> : ''} size={composer?.kind === 'location' ? 'xl' : composer?.kind === 'link' ? 'lg' : 'md'}>
      {composer?.kind === 'options' && <div className="chat-attachment-grid">{ATTACHMENTS.map(item => <Button variant="ghost" className="chat-attachment-option" type="button" key={item.kind} disabled={busy} aria-label={`发送${item.label}`} onClick={() => setComposer({ ...composer, kind: item.kind })}><span><item.icon size={25} aria-hidden="true" /></span><span>{item.label}</span></Button>)}</div>}
      {composer?.kind === 'emoji' && <EmojiPicker onSend={send} busy={busy} onClose={closeComposer} />}
      {composer?.kind === 'kaomoji' && <SimpleComposer onSend={send} busy={busy} onClose={closeComposer} />}
      {composer?.kind === 'location' && <ChatLocationComposer busy={busy} onSend={send} onClose={closeComposer} />}
      {composer?.kind === 'link' && <LinkComposer onSend={send} busy={busy} onClose={closeComposer} />}
      {(composer?.kind === 'image' || composer?.kind === 'video') && <MediaComposer kind={composer.kind} busy={busy} onSend={send} onClose={closeComposer} onUpload={(file, kind) => { const key = composer.target.key; return perform(() => api(`/api/chats/media?key=${encodeURIComponent(key)}&kind=${kind}&filename=${encodeURIComponent(file.name)}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file, timeoutMs: 300000 }), key); }} />}
      {composer?.kind === 'voice' && <Recorder busy={busy} onSend={send} onClose={closeComposer} onRecording={(blob, duration) => { const key = composer.target.key; return perform(async () => { const data = (await fileDataUrl(blob)).split(',')[1]; return api('/api/chats/voice', { method: 'POST', body: { key, duration, mime: blob.type, data }, timeoutMs: 300000 }); }, key); }} />}
    </Modal>
  </div>;
}
