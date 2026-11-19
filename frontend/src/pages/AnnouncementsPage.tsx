import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowUpRight, Bell, ChevronRight, Clock3, Pin, RefreshCw } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader, toast } from '../components/ui';
import AnnouncementMarkdown from './AnnouncementMarkdown';
import { formatTime } from './HomePageParts';
import './announcements-md3.css';

export default function AnnouncementsPage() {
  const { params, navigate } = useApp();
  const id = String(params?.id || '');
  const list = useResource((signal: AbortSignal) => api('/api/announcements', { signal }), []);
  const detail = useResource((signal: AbortSignal) => id ? api(`/api/announcements/${encodeURIComponent(id)}`, { signal }) : Promise.resolve(null), [id]);
  const data: any = list.data;
  const notices: any[] = Array.isArray(data?.notices) ? data.notices : [];
  const notice: any = (detail.data as any)?.notice;
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (id && data && !data.error && !notices.some(n => String(n.id) === id)) {
      toast('这条公告已不在列表中。', 'warning');
      navigate('announcements');
    }
  }, [id, data]);

  async function refresh() {
    setRefreshing(true);
    try { await api('/api/announcements?refresh=1'); await list.reload(); if (id) await detail.reload(); }
    catch (error: any) { toast(error.message, 'danger'); }
    finally { setRefreshing(false); }
  }

  return <div className="stack announcements-page">
    <PageHeader title="公告" description="项目动态、版本更新与使用说明。" actions={<Button variant="secondary" onClick={refresh} disabled={refreshing} aria-busy={refreshing}><RefreshCw size={19} className={refreshing ? 'spin' : ''} aria-hidden="true" />{refreshing ? '刷新中…' : '刷新'}</Button>} />
    {id ? <>
      <div className="announcement-detail-navigation"><Button variant="ghost" onClick={() => navigate('announcements')}><ArrowLeft size={19} aria-hidden="true" />返回公告列表</Button></div>
      {detail.loading && !notice && <LoadingState />}
      {detail.error && <ErrorState error={detail.error} onRetry={detail.reload} />}
      {notice && <Card className="announcement-reader-card">
        <article className="announcement-article">
          <header className="announcement-article-heading">
            <h1>{notice.title}</h1>
            <div className="announcement-article-meta">{notice.pinned && <Badge><Pin size={15} aria-hidden="true" />置顶</Badge>}<span><Clock3 size={17} aria-hidden="true" />发布于 {formatTime(notice.createdAt)}</span>{notice.updatedAt && notice.updatedAt !== notice.createdAt && <span>更新于 {formatTime(notice.updatedAt)}</span>}</div>
          </header>
          <AnnouncementMarkdown source={notice.content} />
        </article>
      </Card>}
    </> : <>
      {list.loading && !data && <LoadingState />}
      {list.error && <ErrorState error={list.error} onRetry={list.reload} />}
      {data && <>
        <div className="announcement-list-summary"><span>共 {notices.length} 条 · 置顶优先</span>{data.error && <Badge tone="warning">离线缓存</Badge>}</div>
        {data.error && notices.length > 0 && <div className="inline-notice announcement-cache-warning" role="status"><Clock3 size={19} aria-hidden="true" /><span>公告更新暂时失败，正在显示本地缓存。</span><Button variant="ghost" onClick={refresh} disabled={refreshing}>重新加载</Button></div>}
        {notices.length ? <div className="announcement-list">{notices.map(notice => <Card key={notice.id} className="announcement-list-card" data-pinned={!!notice.pinned}>
          <button type="button" className="announcement-entry" onClick={() => navigate('announcements', { id: String(notice.id) })}>
            <span className="announcement-entry-icon" aria-hidden="true">{notice.pinned ? <Pin size={24} strokeWidth={1.7} /> : <Bell size={24} strokeWidth={1.7} />}</span>
            <span className="announcement-entry-content"><span className="announcement-entry-meta">{notice.pinned && <Badge>置顶</Badge>}<span>{formatTime(notice.updatedAt || notice.createdAt, true)}</span></span><strong>{notice.title}</strong>{notice.summary && <span className="announcement-entry-summary">{notice.summary}</span>}</span>
            <ChevronRight size={21} className="announcement-entry-arrow" aria-hidden="true" />
          </button>
        </Card>)}</div> : <EmptyState icon={<Bell size={29} strokeWidth={1.7} aria-hidden="true" />} title={data.error ? '公告服务暂时不可用' : '暂无公告'} description={data.error ? '请稍后再试，其他功能仍可使用。' : '新的项目动态会显示在这里。'} action={data.error ? <Button variant="secondary" onClick={refresh} disabled={refreshing}>重新加载<ArrowUpRight size={19} aria-hidden="true" /></Button> : undefined} />}
      </>}
    </>}
  </div>;
}
