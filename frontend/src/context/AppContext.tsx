import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { safeUrl } from '../lib/utils';

type Theme = 'light' | 'dark';
type AppState = {
  watches: any[]; watch: any; watchId: string; setWatchId: (id: any) => void;
  account: any; plugins: any[]; pluginsEnabled: boolean; loading: boolean; watchError: string; tokenInvalid: boolean;
  refreshWatches: () => Promise<void>; refreshAll: () => Promise<void>;
  navigate: (page: string, params?: Record<string, any>) => void; page: string; params: Record<string, any>;
  theme: Theme; setTheme: (theme: Theme) => void;
};
const AppContext = createContext<AppState | null>(null);
export function useOptionalApp() { return useContext(AppContext); }
export function useApp() { const context = useContext(AppContext); if (!context) throw new Error('AppContext is unavailable'); return context; }

function readRoute() {
  const [rawPage, query] = location.hash.replace(/^#\/?/, '').split('?');
  if (rawPage?.startsWith('plugin:')) return { page: 'plugin', params: { id: rawPage.slice(7) } };
  return { page: /^[a-z]+$/.test(rawPage || '') ? rawPage : 'home', params: Object.fromEntries(new URLSearchParams(query || '')) };
}
function stored(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
function save(key: string, value: string) { try { localStorage.setItem(key, value); } catch {} }
function applyBackground(value: any) {
  const background = safeUrl(typeof value === 'string' ? value : value?.background, true);
  document.body.style.backgroundImage = background ? `url(${JSON.stringify(background)})` : '';
  document.body.classList.toggle('custom-background', !!background);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState(readRoute);
  const [watches, setWatches] = useState<any[]>([]);
  const [watchId, updateWatchId] = useState(stored('jz_watch'));
  const [account, setAccount] = useState<any>({ loggedIn: false });
  const [plugins, setPlugins] = useState<any[]>([]);
  const [pluginsEnabled, setPluginsEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [watchError, setWatchError] = useState('');
  const [tokenInvalid, setTokenInvalid] = useState(false);
  const [theme, updateTheme] = useState<Theme>(() => stored('jz_theme') === 'light' ? 'light' : 'dark');
  const generation = useRef(0);
  const mounted = useRef(true);
  const expiredSession = useRef(false);
  const accountRef = useRef(account);
  accountRef.current = account;

  const setWatchId = useCallback((id: any) => { const value = String(id || ''); updateWatchId(value); save('jz_watch', value); }, []);
  const refreshWatches = useCallback(async () => {
    const current = ++generation.current;
    try {
      const acc = await api('/api/account?check=1', { timeoutMs: 12000 });
      if (!mounted.current || current !== generation.current) return;
      setAccount(acc); setTokenInvalid(!!acc?.sessionExpired); expiredSession.current = !!acc?.sessionExpired;
      if (acc?.sessionExpired) { setWatches([]); setWatchId(''); setWatchError(''); return; }
      if (!acc?.loggedIn) { setWatches([]); setWatchId(''); setWatchError(''); return; }
      try {
        const result = await api('/api/watches?refresh=1', { timeoutMs: 12000 });
        if (!mounted.current || current !== generation.current) return;
        const list = result?.watches || [];
        setWatches(list); setWatchError('');
        updateWatchId(previous => { const next = list.some((item: any) => String(item.watchId) === previous) ? previous : String(list[0]?.watchId || ''); save('jz_watch', next); return next; });
      } catch (error: any) {
        if (!mounted.current || current !== generation.current) return;
        // Session rejection is handled by the structured expiry event above.
        // Other platform errors must retain the current account and devices.
        setWatchError(error.message);
      }
    } catch (error: any) { if (mounted.current && current === generation.current) setWatchError(error.message); }
    finally { if (mounted.current && current === generation.current) setLoading(false); }
  }, [setWatchId]);

  useEffect(() => {
    const expired = () => {
      if (!expiredSession.current) generation.current++;
      expiredSession.current = true;
      setTokenInvalid(true); setWatches([]); setWatchId(''); setWatchError(''); setLoading(false);
    };
    window.addEventListener('jz:parent-session-expired', expired);
    return () => window.removeEventListener('jz:parent-session-expired', expired);
  }, [setWatchId]);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    const check = async () => {
      if (pending || document.hidden || controller.signal.aborted) return;
      pending = true;
      try {
        const next = await api('/api/account?check=1', { signal: controller.signal, timeoutMs: 12000 });
        if (controller.signal.aborted || next?.sessionExpired) return;
        const previous = accountRef.current;
        if (!!next?.loggedIn !== !!previous?.loggedIn || next?.userName !== previous?.userName || (expiredSession.current && next?.loggedIn)) {
          await refreshWatches();
          if (!controller.signal.aborted) window.dispatchEvent(new CustomEvent('jz:refresh'));
        }
      } catch { /* Network failures do not establish that an account has expired. */ }
      finally { pending = false; }
    };
    const timer = window.setInterval(check, 30000);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check); };
  }, [refreshWatches]);

  const refreshSupportingData = useCallback(async () => {
    const results = await Promise.allSettled([api('/api/plugins'), api('/api/ui/background')]);
    if (!mounted.current) return;
    if (results[0].status === 'fulfilled') {
      setPlugins(results[0].value?.list || []);
      setPluginsEnabled(results[0].value?.enabled !== false);
    }
    if (results[1].status === 'fulfilled') applyBackground(results[1].value?.background);
  }, []);
  const refreshAll = useCallback(async () => {
    await Promise.allSettled([refreshWatches(), refreshSupportingData()]);
    if (mounted.current) window.dispatchEvent(new CustomEvent('jz:refresh'));
  }, [refreshWatches, refreshSupportingData]);

  useEffect(() => {
    mounted.current = true;
    void refreshWatches(); void refreshSupportingData();
    return () => { mounted.current = false; generation.current++; };
  }, [refreshWatches, refreshSupportingData]);
  useEffect(() => {
    const changed = () => { setRoute(readRoute()); window.scrollTo({ top: 0 }); };
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  const navigate = useCallback((page: string, params: Record<string, any> = {}) => {
    if (page.startsWith('plugin:')) { params = { ...params, id: page.slice(7) }; page = 'plugin'; }
    const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)])).toString();
    const next = `#/${page}${query ? `?${query}` : ''}`;
    if (location.hash === next) setRoute({ page, params }); else location.hash = next;
    window.scrollTo({ top: 0 });
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#171820' : '#f5f5fa');
    window.dispatchEvent(new CustomEvent('jz:theme', { detail: theme }));
    save('jz_theme', theme);
  }, [theme]);
  useEffect(() => { const handler = (event: Event) => applyBackground((event as CustomEvent).detail); window.addEventListener('jz:background', handler); return () => window.removeEventListener('jz:background', handler); }, []);
  useEffect(() => {
    if (!watchId || !account.loggedIn) return;
    const ac = new AbortController();
    const timer = setInterval(async () => {
      if (document.hidden) return;
      try { const status = await api(`/api/watch/${encodeURIComponent(watchId)}/status`, { signal: ac.signal }); if (!ac.signal.aborted) setWatches(previous => previous.map(item => String(item.watchId) === watchId ? { ...item, ...status } : item)); } catch {}
    }, 30000);
    return () => { clearInterval(timer); ac.abort(); };
  }, [watchId, account.loggedIn]);

  return <AppContext.Provider value={{ watches, watch: watches.find(item => String(item.watchId) === watchId) || null, watchId, setWatchId, account, plugins, pluginsEnabled, loading, watchError, tokenInvalid, refreshWatches, refreshAll, navigate, page: route.page, params: route.params, theme, setTheme: updateTheme }}>{children}</AppContext.Provider>;
}
