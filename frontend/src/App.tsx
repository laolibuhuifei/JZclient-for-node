import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, ChevronUp, Grid2X2, Home, List, MapPin, MessageCircle, Moon, Puzzle, RefreshCw, ShieldCheck, Sun, UserRound, X } from 'lucide-react';
import { AppProvider, useApp } from './context/AppContext';
import { layoutRect, layoutViewport } from './lib/displayScale';
import { api, post } from './lib/api';
import { Button, EmptyState, ErrorState, Field, Input, LoadingState, ToastHost, toast } from './components/ui';
import CloudUpdate from './components/CloudUpdate';
import { useSlidingIndicator } from './components/useSlidingIndicator';
import HomePage from './pages/HomePage';
import AccountPage from './pages/AccountPage';
import OverviewPage from './pages/OverviewPage';
import AnnouncementsPage from './pages/AnnouncementsPage';
import ChatPage from './pages/ChatPage';
import LocationPage from './pages/LocationPage';
import GuardPage from './pages/GuardPage';
import FeaturesPage from './pages/FeaturesPage';
import DevicePage from './pages/DevicePage';
import IntegrationsPage from './pages/IntegrationsPage';
import AiPage from './pages/AiPage';
import PluginsPage from './pages/PluginsPage';
import PluginPage from './pages/PluginPage';
import BindPage from './pages/BindPage';
import LogsPage from './pages/LogsPage';
import './route-motion.css';
import './pages/home-shell.css';

const navigation = [{ page: 'home', title: '主页', icon: Home }, { page: 'chat', title: '聊天', icon: MessageCircle }, { page: 'location', title: '定位', icon: MapPin }, { page: 'more', title: '功能', icon: Grid2X2 }, { page: 'me', title: '我的', icon: UserRound }, { page: 'plugins', title: '插件', icon: Puzzle }];
const devicePages = ['overview', 'location', 'guard', 'profile', 'friends', 'contacts', 'health', 'apps', 'wifi', 'alarms', 'settings', 'hidden'];
const pageNames: Record<string, string> = { home: '主页', chat: '聊天', location: '定位', more: '全部功能', me: '我的', account: '账号', overview: '设备概览', announcements: '公告', guard: '安全区域', profile: '宝贝资料', friends: '手表好友', contacts: '通讯录', health: '健康数据', apps: '应用管理', wifi: 'Wi-Fi', alarms: '闹钟', settings: '设备设置', hidden: '高级信息', ai: 'AI 助手', plugins: '插件管理', plugin: '插件应用', bind: '绑定手表', logs: '实时日志' };
type NavigationEntry = { key: string; page: string; title: string; icon: typeof Home; pluginId?: string };

class PageBoundary extends React.Component<{ children: React.ReactNode }, { error: any }> {
  state = { error: null };
  static getDerivedStateFromError(error: any) { return { error }; }
  render() { return this.state.error ? <ErrorState error={this.state.error} onRetry={() => this.setState({ error: null })} /> : this.props.children; }
}
function RouteView() {
  const { page, watchId, account, loading, watchError, tokenInvalid, navigate, refreshWatches } = useApp();
  if (loading && devicePages.includes(page)) return <LoadingState />;
  if (devicePages.includes(page) && !watchId) {
    if (watchError && account.loggedIn) return <ErrorState error={watchError} onRetry={refreshWatches} />;
    const needLogin = !account.loggedIn || tokenInvalid;
    return <EmptyState title={tokenInvalid ? '家长账号登录已过期' : needLogin ? '登录后，连接孩子的手表' : '添加你的第一块手表'} description={needLogin ? '使用家长端账号登录，即可查看和管理已绑定的手表。' : '绑定后，位置、健康和设备设置会出现在这里。'} action={<Button onClick={() => navigate(needLogin ? 'account' : 'bind')}>{needLogin ? '登录家长账号' : '绑定手表'}<ArrowRight size={16} /></Button>} />;
  }
  const pages: Record<string, React.ComponentType> = { home: HomePage, account: AccountPage, overview: OverviewPage, announcements: AnnouncementsPage, chat: ChatPage, location: LocationPage, guard: GuardPage, more: FeaturesPage, me: IntegrationsPage, ai: AiPage, plugins: PluginsPage, plugin: PluginPage, bind: BindPage, logs: LogsPage };
  const Component = pages[page] || (devicePages.includes(page) ? DevicePage : FeaturesPage);
  return <Component />;
}
function Shell() {
  const { page, params, navigate, watches, watchId, account, refreshAll, plugins, pluginsEnabled, theme, setTheme, tokenInvalid, watchError } = useApp();
  const [refreshing, setRefreshing] = useState(false);
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  const chatThreadRoute = page === 'chat' && !!params.key && account.loggedIn && !tokenInvalid;
  const [expanded, setExpanded] = useState(false);
  const dock = useRef<HTMLElement>(null);
  const moreTrigger = useRef<HTMLButtonElement>(null);
  const morePanel = useRef<HTMLDivElement>(null);
  const moreId = useId();
  const moreHeadingId = useId();
  const active = ['chat', 'location', 'home', 'plugins'].includes(page) ? page : page === 'announcements' ? 'home' : ['me', 'account', 'logs'].includes(page) ? 'me' : page === 'plugin' ? 'plugins' : 'more';
  const pluginEntries: NavigationEntry[] = (pluginsEnabled === false ? [] : plugins).filter(item => item.hasUi && item.loaded && !item.disabled).map(item => ({
    key: `plugin:${item.id}`, page: 'plugin', pluginId: String(item.id), title: item.uiTitle || item.name || String(item.id), icon: Puzzle,
  }));
  const entries: NavigationEntry[] = [...navigation.map(item => ({ ...item, key: item.page })), ...pluginEntries];
  const selected = page === 'plugin' && pluginEntries.some(item => item.pluginId === String(params.id)) ? `plugin:${params.id}` : active;
  const mobileOverflow = mobile && entries.length > 5;
  const visibleEntries = mobileOverflow ? entries.slice(0, 4) : entries;
  const overflowEntries = mobileOverflow ? entries.slice(4) : [];
  const overflowSelected = mobileOverflow && overflowEntries.some(item => item.key === selected);
  const selectedTitle = entries.find(item => item.key === selected)?.title || '我的';
  const dockIndicator = useSlidingIndicator(dock, overflowSelected ? 'overflow' : selected, 'navigation', visibleEntries.map(item => item.key).join('|') + `/${mobileOverflow}`);
  const subpage = !navigation.some(item => item.page === page);
  const nextTheme = theme === 'light' ? 'dark' : 'light';
  const ThemeIcon = theme === 'light' ? Moon : Sun;
  const pageIdentity = `${page}/${params.id || ''}`;
  // Home keeps its resources while only the selected device content changes.
  const boundaryIdentity = `${pageIdentity}/${['home', 'chat'].includes(page) ? '' : watchId}`;
  useEffect(() => { document.title = `${pageNames[page] || '全部功能'} · JZClientForNode`; }, [page]);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 767px)');
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useLayoutEffect(() => {
    if (!mobile || !chatThreadRoute) return;
    const scrollTop = window.scrollY;
    document.documentElement.classList.add('chat-mobile-open');
    return () => {
      document.documentElement.classList.remove('chat-mobile-open');
      window.scrollTo({ top: scrollTop, behavior: 'instant' });
    };
  }, [mobile, chatThreadRoute]);
  useEffect(() => {
    if (morePanel.current?.matches(':popover-open')) morePanel.current.hidePopover();
    setExpanded(false);
  }, [pageIdentity, mobileOverflow]);
  useEffect(() => {
    if (!expanded) return;
    let frame = 0;
    const update = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(positionMore); };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [expanded]);
  function positionMore() {
    if (!dock.current || !moreTrigger.current || !morePanel.current) return;
    const anchor = layoutRect(moreTrigger.current);
    const dockBounds = layoutRect(dock.current);
    const header = document.querySelector('.app-header');
    const headerBottom = header ? layoutRect(header).bottom : 76;
    const viewport = layoutViewport();
    const width = Math.min(360, viewport.width - 32);
    const left = Math.max(16, Math.min(anchor.right - width, viewport.width - width - 16));
    const availableHeight = Math.max(64, dockBounds.top - headerBottom - 24);
    morePanel.current.style.setProperty('--nav-more-left', `${left}px`);
    morePanel.current.style.setProperty('--nav-more-bottom', `${viewport.height - dockBounds.top + 8}px`);
    morePanel.current.style.setProperty('--nav-more-width', `${width}px`);
    morePanel.current.style.setProperty('--nav-more-height', `${Math.min(440, availableHeight)}px`);
  }
  function closeMore() {
    morePanel.current?.hidePopover?.();
    moreTrigger.current?.focus({ preventScroll: true });
  }
  function openEntry(item: NavigationEntry) {
    closeMore();
    navigate(item.page, item.pluginId ? { id: item.pluginId } : undefined);
  }
  async function refresh() { setRefreshing(true); try { await refreshAll(); toast('已刷新'); } finally { setRefreshing(false); } }
  return <div className={`app-shell page-${page}${chatThreadRoute ? ' chat-thread-route' : ''}`}>
    <a className="skip-link" href="#main-content">跳到主要内容</a>
    <header className="app-header"><div className="header-inner"><button className="brand" type="button" onClick={() => navigate('home')} aria-label="JZClientForNode 主页"><img className="home-brand-image" src="/assets/icon.png" alt="" width="48" height="48" /><span>JZClientForNode<span className="brand-caption">手表家长端</span></span></button>
      <div className="header-actions"><span className="header-connection"><i className="status-dot online" />本地服务已连接</span><Button variant="ghost" size="icon" aria-label={`切换为${nextTheme === 'light' ? '浅色' : '深色'}主题，当前${theme === 'light' ? '浅色' : '深色'}`} title={`切换为${nextTheme === 'light' ? '浅色' : '深色'}主题`} onClick={() => setTheme(nextTheme)}><ThemeIcon size={19} /></Button><Button variant="ghost" size="icon" aria-label="实时日志" title="实时日志" onClick={() => navigate('logs')}><List size={19} /></Button>{page !== 'home' && <Button variant="ghost" size="icon" aria-label="刷新页面数据" title="刷新" disabled={refreshing} onClick={refresh}><RefreshCw size={18} className={refreshing ? 'spin' : ''} /></Button>}<button type="button" className="account-chip" onClick={() => navigate('account')} aria-label={account.loggedIn ? `管理家长账号：${account.userName || '我的账号'}` : '登录家长账号'}><span className="account-avatar"><UserRound size={16} /></span><span>{account.loggedIn ? account.userName || '我的账号' : '登录账号'}</span></button></div>
    </div></header>
    <main id="main-content" className="main-content" tabIndex={-1}>
      {page !== 'home' && <div className="shell-page-tools">{subpage && <button type="button" className="back-link" onClick={() => navigate(active === 'home' ? 'home' : active === 'me' ? 'me' : 'more')}><ArrowLeft size={16} />{active === 'home' ? '返回主页' : active === 'me' ? '返回我的' : '返回全部功能'}</button>}<Button className="shell-mobile-refresh" variant="ghost" loading={refreshing} onClick={refresh} aria-label="刷新页面数据">{!refreshing && <RefreshCw size={18} aria-hidden="true" />}刷新数据</Button></div>}
      {tokenInvalid && page !== 'account' && <div className="inline-notice" role="alert"><ShieldCheck size={18} /><span>家长账号登录已失效，请重新登录。</span><Button variant="secondary" size="sm" onClick={() => navigate('account')}>重新登录</Button></div>}
      {watchError && account.loggedIn && !tokenInvalid && <div className="inline-notice"><Activity size={18} /><span>手表列表暂未更新：{watchError}</span><Button variant="ghost" size="sm" onClick={refresh}>重试</Button></div>}
      <div className="route-transition" key={pageIdentity}><PageBoundary key={boundaryIdentity}><RouteView /></PageBoundary></div>
      <footer className="app-footer"><span className="powered-by"><img className="footer-mascot" src="/assets/node-mascot.svg" alt="Node.js" width="21" height="24" />powered by <a href="https://github.com/laolibuhuifei" target="_blank" rel="noopener noreferrer">laolibuhuifei</a></span></footer>
    </main>
    <nav ref={dock} className="floating-dock" aria-label="主导航"><span className="selection-indicator" ref={dockIndicator} aria-hidden="true" />{visibleEntries.map(item => <button type="button" className={`dock-item ${item.pluginId ? 'dock-plugin-app' : ''} ${selected === item.key ? 'active' : ''}`} data-nav-value={item.key} key={item.key} aria-current={selected === item.key ? 'page' : undefined} title={item.title} onClick={() => navigate(item.page, item.pluginId ? { id: item.pluginId } : undefined)}><item.icon size={21} strokeWidth={1.7} /><span className="navigation-entry-label"><span className="navigation-entry-title">{item.title}</span>{item.pluginId && <span className="navigation-plugin-badge">插件</span>}</span></button>)}{mobileOverflow && <Button ref={moreTrigger} variant="ghost" className={`dock-item dock-more ${overflowSelected ? 'active' : ''}`} data-nav-value="overflow" popoverTarget={moreId} aria-label={overflowSelected ? `更多板块，当前${selectedTitle}` : '展开更多板块'} aria-haspopup="dialog" aria-controls={moreId} aria-expanded={expanded} aria-current={overflowSelected ? 'true' : undefined}><ChevronUp size={21} strokeWidth={1.7} aria-hidden="true" /><span>更多</span></Button>}</nav>
    {mobileOverflow && <div ref={morePanel} id={moreId} popover="auto" className="nav-more-popover" role="dialog" aria-modal="false" aria-labelledby={moreHeadingId} tabIndex={-1}
      onBeforeToggle={event => { if ((event.nativeEvent as ToggleEvent).newState === 'open') positionMore(); }}
      onToggle={event => {
        const open = (event.nativeEvent as ToggleEvent).newState === 'open';
        setExpanded(open);
        if (open) {
          const items = morePanel.current?.querySelector<HTMLElement>('.nav-more-items');
          if (items) items.scrollTop = 0;
          const target = morePanel.current?.querySelector<HTMLButtonElement>('[aria-current="page"]') || morePanel.current?.querySelector<HTMLButtonElement>('.nav-more-entry');
          target?.focus({ preventScroll: true });
          target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        else if (morePanel.current?.contains(document.activeElement)) moreTrigger.current?.focus({ preventScroll: true });
      }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMore(); } }}>
      <div className="nav-more-heading"><h2 id={moreHeadingId}>更多板块</h2><Button variant="ghost" size="icon" aria-label="关闭更多板块" onClick={closeMore}><X size={19} aria-hidden="true" /></Button></div>
      <nav className="nav-more-items" aria-label="其他板块"><ul className="nav-more-list">{overflowEntries.map(item => <li key={item.key}><button type="button" className={`nav-more-entry ${selected === item.key ? 'active' : ''}`} data-nav-value={item.key} aria-current={selected === item.key ? 'page' : undefined} onClick={() => openEntry(item)}><item.icon size={23} strokeWidth={1.7} aria-hidden="true" /><span className="navigation-entry-label"><span className="navigation-entry-title">{item.title}</span>{item.pluginId && <span className="navigation-plugin-badge">插件</span>}</span></button></li>)}</ul></nav>
    </div>}
    <CloudUpdate />
  </div>;
}
export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState(location.search.includes('auth=fail') ? '访问链接已失效，请输入访问令牌。' : '');
  const [busy, setBusy] = useState(false);
  const [gateDark, setGateDark] = useState(document.documentElement.dataset.theme !== 'light');
  useEffect(() => {
    const ac = new AbortController();
    api('/api/auth/status', { signal: ac.signal, timeoutMs: 8000 }).then(data => { if (!ac.signal.aborted) setAuthed(!!data.authed); }).catch(e => { if (!ac.signal.aborted) { setError(e.message); setAuthed(false); } });
    const unauthorized = () => { setAuthed(false); setError('访问令牌已失效，请重新验证。'); };
    window.addEventListener('jz:unauthorized', unauthorized);
    return () => { ac.abort(); window.removeEventListener('jz:unauthorized', unauthorized); };
  }, []);
  useEffect(() => { if (!authed) document.title = `${authed === null ? '正在连接' : '访问验证'} · JZClientForNode`; }, [authed]);
  async function unlock(event: React.FormEvent) {
    event.preventDefault(); if (!token.trim()) { setError('请输入访问令牌'); return; }
    setBusy(true); setError('');
    try { await post('/api/auth/login', { token: token.trim() }); setToken(''); setAuthed(true); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <><ToastHost />{authed === null ? <div className="boot-screen"><img className="boot-brand-image" src="/assets/icon.png" alt="" width="56" height="56" /><LoadingState text="正在连接本地服务…" /></div> : authed ? <AppProvider><Shell /></AppProvider> : <div className="auth-page">
    <button type="button" className="auth-theme button button-ghost button-icon" aria-label={`切换为${gateDark ? '浅色' : '深色'}主题`} onClick={() => { const dark = !gateDark; setGateDark(dark); document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#171820' : '#f5f5fa'); window.dispatchEvent(new CustomEvent('jz:theme', { detail: dark ? 'dark' : 'light' })); try { localStorage.setItem('jz_theme', dark ? 'dark' : 'light'); } catch {} }}>{gateDark ? <Sun size={20} /> : <Moon size={20} />}</button>
    <div className="auth-brand"><img className="auth-brand-image" src="/assets/icon.png" alt="" width="48" height="48" /><span>JZClientForNode</span></div>
    <section className="auth-card" aria-labelledby="auth-heading"><div className="auth-card-heading"><span className="auth-access-icon"><ShieldCheck size={27} aria-hidden="true" /></span><h1 id="auth-heading">连接你的面板</h1><p>验证访问令牌后，查看手表与管理服务。</p></div><form onSubmit={unlock} noValidate><Field label="访问令牌"><Input type="password" value={token} onChange={event => setToken(event.target.value)} placeholder="输入面板访问令牌" autoComplete="off" autoFocus required disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'auth-token-error' : 'auth-token-note'} /></Field>{error && <p id="auth-token-error" className="field-error" role="alert">{error}</p>}<Button type="submit" loading={busy} aria-busy={busy}>进入面板 <ArrowRight size={17} aria-hidden="true" /></Button></form><p id="auth-token-note" className="auth-note">使用此面板的访问令牌验证身份。家长账号可在进入后登录。</p></section><footer className="app-footer auth-footer"><span className="powered-by"><img className="footer-mascot" src="/assets/node-mascot.svg" alt="Node.js" width="21" height="24" />powered by <a href="https://github.com/laolibuhuifei" target="_blank" rel="noopener noreferrer">laolibuhuifei</a></span></footer>
  </div>}</>;
}
