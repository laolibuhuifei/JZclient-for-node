import React, { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Bell, Bot, Check, ChevronRight, Clock3, Cpu, LayoutGrid, LogIn, Puzzle, Plus, RefreshCw, Server, ShieldCheck, UserRound, Watch, Wifi, X } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Skeleton } from '../components/ui';
import { DetailRows, formatBytes, formatDuration, formatTime, percent } from './HomePageParts';
import HomeLocationPreview from './HomeLocationPreview';
import HomeWatchPicker from './HomeWatchPicker';
import HomeWatchInfoDialog from './HomeWatchInfoDialog';
import HomeRuntimeTrends from './HomeRuntimeTrends';
import AnchoredPopover from '../components/AnchoredPopover';
import './home-md3.css';

const OS_NAMES: Record<string, string> = { darwin: 'macOS', linux: 'Linux', win32: 'Windows', freebsd: 'FreeBSD', openbsd: 'OpenBSD', sunos: 'Solaris', aix: 'AIX' };

function HomeSkeleton() {
  return <div className="home-loading" role="status" aria-label="正在读取主页数据">
    <span className="sr-only">正在同步手表与服务状态…</span>
    <Card className="home-loading-workspace">
      <Skeleton className="home-loading-title" />
      <div className="home-loading-columns"><div><Skeleton /><Skeleton /></div><Skeleton className="home-loading-controls" /></div>
    </Card>
    <div className="home-loading-panels"><Skeleton /><Skeleton /><Skeleton /></div>
  </div>;
}

export default function HomePage() {
  const { navigate, setWatchId, watchId, account: globalAccount, watches: globalWatches, tokenInvalid, refreshWatches } = useApp();
  const system = useResource((signal: AbortSignal) => api('/api/system', { signal }), [], 3000);
  const announcements = useResource((signal: AbortSignal) => api('/api/announcements', { signal }), []);
  const forceQuote = useRef(false);
  const quote = useResource((signal: AbortSignal) => api(`/api/yiyan${forceQuote.current ? '?refresh=1' : ''}`, { signal }), []);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingNotices, setRefreshingNotices] = useState(false);
  const [noticeRefreshError, setNoticeRefreshError] = useState('');
  const [infoWatchId, setInfoWatchId] = useState<string | null>(null);
  const data: any = system.data;
  const a = data?.account || globalAccount || {};
  const s = data?.system || {};
  const p = data?.process || {};
  const loginReady = !!a.loggedIn && !tokenInvalid;
  const watches: any[] = loginReady && Array.isArray(data?.account?.watches) ? data.account.watches.map((summary: any) => ({
    ...(globalWatches || []).find(watch => String(watch.watchId) === String(summary.watchId)),
    ...summary,
  })) : [];
  const selectedWatch = watches.find(watch => String(watch.watchId) === String(watchId)) || watches[0];
  const infoWatch = watches.find(watch => String(watch.watchId) === infoWatchId);
  const infoAvailable = !!infoWatch;
  useEffect(() => { if (infoWatchId && !infoAvailable) setInfoWatchId(null); }, [infoWatchId, infoAvailable]);
  const noticeData: any = announcements.data;
  const notices: any[] = Array.isArray(noticeData?.notices) ? noticeData.notices : [];
  const noticeError = noticeRefreshError || announcements.error || noticeData?.error;
  const q: any = quote.data;
  const now = new Date();
  const dateLabel = now.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
  const quoteSource = [q?.author, q?.from && `《${String(q.from).replace(/^《|》$/g, '')}》`, q?.upstream === 'local' && '离线词库'].filter(Boolean).join(' · ');
  const environmentFields = [
    ['系统架构', `${OS_NAMES[s.platform] || s.platform || '—'} · ${s.arch || '—'}`],
    ['Node.js', `${p.node || '—'} · ${p.arch || '—'}`],
    ['处理器', s.cpuModel || '—'], ['主机名', s.hostname || '—'],
  ];

  async function refresh() {
    setRefreshing(true);
    try { await Promise.all([system.reload(), announcements.reload(), refreshWatches()]); }
    finally { setRefreshing(false); }
  }

  async function refreshQuote() {
    forceQuote.current = true;
    try { await quote.reload(); }
    finally { forceQuote.current = false; }
  }

  async function refreshNotices() {
    setRefreshingNotices(true);
    setNoticeRefreshError('');
    try { await api('/api/announcements?refresh=1'); await announcements.reload(); }
    catch (error: any) { setNoticeRefreshError(error.message || '公告刷新失败，请重试。'); }
    finally { setRefreshingNotices(false); }
  }

  function openDevicePage(page: string) {
    if (!loginReady) { navigate('account'); return; }
    if (!selectedWatch) { navigate('bind'); return; }
    setWatchId(String(selectedWatch.watchId));
    navigate(page);
  }

  const connections = [
    { title: '家长账号', detail: tokenInvalid ? '登录已过期，请重新登录' : loginReady ? a.userName || '家长账号已登录' : '登录后同步手表', status: tokenInvalid ? '已过期' : loginReady ? '已登录' : '未登录', online: loginReady, warning: tokenInvalid, icon: UserRound, page: 'account', label: tokenInvalid ? '重新登录家长账号' : '管理家长账号' },
    { title: '消息连接', detail: loginReady && a.imConnected ? '手表消息已连接' : '查看聊天与连接', status: loginReady && a.imConnected ? '已连接' : '未连接', online: loginReady && !!a.imConnected, warning: false, icon: Wifi, page: 'chat', label: '查看聊天与消息连接' },
    { title: 'OneBot', detail: '机器人与第三方服务', status: a.onebotRunning ? '运行中' : '未启动', online: !!a.onebotRunning, warning: false, icon: Bot, page: 'me', label: '管理 OneBot 集成' },
  ];
  const shortcuts = [
    { title: '安全区域', description: '守护范围与提醒', icon: ShieldCheck, action: () => openDevicePage('guard') },
    { title: '全部功能', description: '手表设置与管理', icon: LayoutGrid, action: () => navigate('more') },
    { title: '插件', description: '安装与管理扩展', icon: Puzzle, action: () => navigate('plugins') },
    { title: '账号与集成', description: '账号和服务配置', icon: UserRound, action: () => navigate('me') },
  ];

  return <div className="home-dashboard">
    <div className="home-heading">
      <PageHeader title="主页" description={<time dateTime={now.toISOString()}>{dateLabel}</time>} actions={<Button variant="secondary" size="icon" onClick={refresh} disabled={refreshing} aria-label="刷新主页数据" title={refreshing ? '刷新中' : '刷新主页数据'} aria-busy={refreshing}><RefreshCw size={19} aria-hidden="true" /></Button>} />
      <aside className="home-heading-quote" aria-label="每日一言"><div>
        {quote.loading && !q ? <p role="status">正在加载一言…</p> : q?.text ? <><blockquote title={quoteSource || undefined}>{q.text}</blockquote>{quoteSource && <cite>{quoteSource}</cite>}</> : <p>{quote.error ? '一言暂时无法加载，点击重试。' : '暂时没有一言，点击换一句。'}</p>}
        {quote.error && q?.text && <p className="home-update-warning" role="status">刷新失败，已保留上一条一言。</p>}
      </div><Button variant="ghost" size="icon" title="换一句" aria-label="换一句一言" disabled={quote.loading} onClick={refreshQuote}><RefreshCw size={17} aria-hidden="true" /></Button></aside>
      <nav className="home-connections" aria-label="连接状态"><ul>{connections.map(item => <li key={item.title}><Button variant="ghost" className="home-connection" data-tone={item.online ? 'success' : 'error'} onClick={() => navigate(item.page)} aria-label={item.label} aria-describedby={`home-connection-${item.page}`} title={`${item.title}：${item.detail} · ${item.status}`}>
        <item.icon size={20} strokeWidth={1.6} aria-hidden="true" /><strong>{item.title}</strong><span className="home-connection-result" aria-hidden="true">{item.online ? <Check size={13} strokeWidth={2.8} /> : <X size={13} strokeWidth={2.8} />}</span><span id={`home-connection-${item.page}`} className="sr-only">{item.status}{item.page === 'account' && loginReady && a.userName ? `，${a.userName}` : ''}</span>
      </Button></li>)}</ul></nav>
    </div>

    {system.loading && !data && <HomeSkeleton />}
    {system.error && !data && <ErrorState error={system.error} onRetry={system.reload} />}

    {data && <>
      {system.error && <div className="home-stale" role="status"><Clock3 size={20} aria-hidden="true" /><span>连接暂时中断，以下为上次读取的数据。</span><Button variant="ghost" onClick={refresh} disabled={refreshing}>重新连接</Button></div>}

      <div className="home-content-layout">
      <div className="home-main-layout" data-has-watch={!!selectedWatch}>
      <Card className="home-workspace" title="我的手表" description={loginReady ? `${watches.length} 台已绑定` : '连接家长账号，同步你的设备'} action={<Button variant="ghost" onClick={() => navigate(loginReady ? 'bind' : 'account')}><Plus size={19} aria-hidden="true" />绑定手表</Button>} aria-label="我的手表">
        {selectedWatch ? <div className="home-watch-area">
          <HomeWatchPicker watches={watches} selectedId={String(selectedWatch.watchId)} onSelect={setWatchId} onInfo={setInfoWatchId} />
          <div className="home-device-content" key={String(selectedWatch.watchId)}>
            <HomeLocationPreview watchId={String(selectedWatch.watchId)} onOpen={() => openDevicePage('location')} />
          </div>
        </div> : <EmptyState icon={loginReady ? <Watch size={32} strokeWidth={1.6} aria-hidden="true" /> : <UserRound size={32} strokeWidth={1.6} aria-hidden="true" />} title={tokenInvalid ? '重新连接你的手表' : loginReady ? '添加第一块手表' : '你的手表，从这里连接'} description={tokenInvalid ? '家长账号登录已过期，重新登录即可继续查看。' : loginReady ? '绑定手表后，就能查看位置、收发消息和管理设备。' : '使用家长账号登录，同步已经绑定的手表。'} action={<Button onClick={() => navigate(loginReady ? 'bind' : 'account')} aria-label={tokenInvalid ? '重新登录' : loginReady ? '添加第一块手表' : '登录家长账号'}>{loginReady ? <Plus size={20} aria-hidden="true" /> : <LogIn size={20} aria-hidden="true" />}{tokenInvalid ? '重新登录' : loginReady ? '添加手表' : '登录家长账号'}<ArrowRight size={18} aria-hidden="true" /></Button>} />}
      </Card>

      <Card className="home-runtime" title="运行状态" aria-label="服务运行" action={<span className="home-runtime-icon" aria-hidden="true"><Clock3 size={22} strokeWidth={1.7} /></span>}>
        <p className="home-uptime">已运行 {formatDuration(p.uptime)}</p>
        <HomeRuntimeTrends sample={system.data} interrupted={!!system.error} />
        <div className="home-memory-summary"><span>系统内存用量</span><span>{formatBytes(s.memUsed)} / {formatBytes(s.memTotal)}</span></div>
        <div className="home-process-memory"><span>程序内存</span><strong>{formatBytes(p.rss)}</strong></div>
      </Card>

      </div>

      <div className="home-secondary-layout">
        <Card className="home-shortcuts" title="常用功能" aria-label="常用功能"><ul>{shortcuts.map(item => <li key={item.title}><Button variant="ghost" className="home-shortcut" onClick={item.action}>
          <span className="home-shortcut-icon" aria-hidden="true"><item.icon size={23} strokeWidth={1.7} /></span><span><strong>{item.title}</strong><small>{item.description}</small></span><ChevronRight size={18} aria-hidden="true" />
        </Button></li>)}</ul></Card>

        <Card className="home-announcements" title="最近公告" aria-label="最近公告" action={<Button variant="ghost" size="icon" onClick={() => navigate('announcements')} aria-label="查看全部公告" title="查看全部公告"><ArrowUpRight size={22} aria-hidden="true" /></Button>}>
          {announcements.loading && !noticeData ? <div className="home-notice-loading" role="status" aria-label="正在读取公告"><Skeleton /><Skeleton /><span className="sr-only">正在读取公告…</span></div> : notices.length ? <ul className="home-notice-list">{notices.slice(0, 2).map(notice => <li key={notice.id}><Button variant="ghost" className="home-notice" onClick={() => navigate('announcements', { id: String(notice.id) })}>
            <span className="home-notice-meta">{notice.pinned && <Badge>置顶</Badge>}<span>{formatTime(notice.updatedAt || notice.createdAt, true)}</span></span><strong>{notice.title}</strong>{notice.summary && <span className="home-notice-summary">{notice.summary}</span>}
          </Button></li>)}</ul> : <EmptyState icon={<Bell size={25} aria-hidden="true" />} title={noticeError ? '公告暂时无法加载' : '暂时没有新公告'} description={noticeError ? '稍后重试，获取最新公告。' : '新消息会出现在这里。'} action={<Button variant="secondary" disabled={refreshingNotices} onClick={refreshNotices}><RefreshCw size={17} aria-hidden="true" />{refreshingNotices ? '正在加载' : '重新加载'}</Button>} />}
          {notices.length > 0 && noticeError && <div className="home-update-warning" role="status"><span>更新失败，已保留缓存公告。</span><Button variant="ghost" disabled={refreshingNotices} onClick={refreshNotices}>重试</Button></div>}
        </Card>

      </div>

      <div className="home-system-layout">
      <Card id="home-panel-environment" className="home-panel-environment" title={<span><Server size={23} strokeWidth={1.6} aria-hidden="true" />面板运行环境</span>} aria-label="面板运行环境" action={<Button variant="ghost" onClick={() => navigate('logs')}>实时日志<ArrowUpRight size={18} aria-hidden="true" /></Button>}>
        <dl className="home-environment-grid">{environmentFields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <AnchoredPopover className="home-environment" title="进程与账号详情" icon={<Cpu size={18} aria-hidden="true" />}><DetailRows items={[
          ['内核版本', s.release || '—'], ['处理器核心', `${s.cpuCores || 0} 核`],
          ['程序运行', formatDuration(p.uptime)], ['系统运行', formatDuration(s.uptime)],
          ['系统负载（1 / 5 / 15 分钟）', (s.loadavg || []).map((value: any) => Number(value).toFixed(2)).join(' / ') || '—'],
          ['进程 PID', p.pid || '—'], ['程序 CPU（相对单核）', percent(p.cpuPercent)], ['程序内存', formatBytes(p.rss)],
          ['堆内存（已用 / 分配）', `${formatBytes(p.heapUsed)} / ${formatBytes(p.heapTotal)}`], ['外部内存', formatBytes(p.external)],
          ['当前账号', loginReady ? a.userName || '家长账号' : '未登录'], ['mobileId', loginReady ? a.mobileId || '—' : '—'], ['绑定手表', `${loginReady ? a.watchCount ?? watches.length : 0} 台`],
        ]} /></AnchoredPopover>
      </Card>
      </div>
      </div>
    </>}
    <HomeWatchInfoDialog watch={infoWatch} onClose={() => setInfoWatchId(null)} onOpenDetails={() => {
      if (!infoWatch) return;
      setWatchId(String(infoWatch.watchId));
      setInfoWatchId(null);
      navigate('overview');
    }} />
  </div>;
}
