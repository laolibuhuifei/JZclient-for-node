import React, { useState } from 'react';
import { Image, Play, RefreshCw, Search, Settings2 } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, Tabs, Toggle, toast } from '../ui';
import { PreviewImage, SessionPicker, StatusRow } from './shared';

export default function BiliPanel() {
  const { watchId, watch, navigate } = useApp();
  const resource = useResource(() => api('/api/bili'), [watchId]);
  const [editor, setEditor] = useState('');
  const [keyword, setKeyword] = useState('');
  const [bvid, setBvid] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState<any>(null);
  const [searchError, setSearchError] = useState('');
  const [searchImage, setSearchImage] = useState('');
  const [commentImage, setCommentImage] = useState('');
  const data: any = resource.data;
  if (resource.loading && !data) return <LoadingState />;
  if (resource.error) return <ErrorState error={resource.error} onRetry={resource.reload} />;
  if (!data) return null;
  const current = data.watches?.find((entry: any) => String(entry.watchId) === String(watchId)) || {
    watchId, name: watch?.name || watchId, enabled: false, auto: true, keys: [],
    maxDuration: 600, maxBytes: 100 * 1024 * 1024, maxPerDay: 20, commentImage: true, searchImage: true,
  };
  const search = async () => {
    const query = keyword.trim();
    if (!query) { toast('请输入搜索关键词', 'error'); return; }
    setSearching(true); setSearchError('');
    try { setSearchResult(await api('/api/bili/search?kw=' + encodeURIComponent(query))); }
    catch (error: any) { setSearchError(error.message || '搜索失败'); }
    finally { setSearching(false); }
  };
  return <div className="stack integration-panel integration-bili-panel"><Card title={<span className="integration-title"><Play size={25} aria-hidden="true" />B 站点播</span>} description="在微聊中搜索视频、点播和查看评论长图。" className="integration-service-card" action={<Button variant="ghost" size="icon" onClick={resource.reload} aria-label="刷新点播状态"><RefreshCw size={20} /></Button>}>
    {!watchId ? <EmptyState title="先选择一块手表" description="点播开关、会话范围和每日限额按手表分别保存。" /> : <>
      <div className="integration-bili-summary"><div><StatusRow label="当前手表">{current.name || watchId}</StatusRow><StatusRow label="点播状态"><Badge tone={current.enabled ? 'success' : 'neutral'}>{current.enabled ? '已启用' : '未启用'}</Badge></StatusRow>
      <StatusRow label="会话范围">{current.auto ? '自动匹配' : '手动指定'} · {current.keys.length ? `${current.keys.length} 个会话` : '尚未匹配'}</StatusRow>
      {!!current.keys.length && <div className="integration-chips">{current.keys.map((key: string) => <Badge key={key}>{data.targets?.find((target: any) => target.key === key)?.name || key}</Badge>)}</div>}</div><div className="integration-bili-limits">
      <StatusRow label="单条限制">{current.maxDuration ? `${current.maxDuration / 60} 分钟` : '不限时长'} · {current.maxBytes ? `${Math.round(current.maxBytes / 1024 / 1024)} MB` : '不限大小'}</StatusRow>
      <StatusRow label="每天上限">{current.maxPerDay ? `${current.maxPerDay} 条` : '不限'}</StatusRow>
      <StatusRow label="搜索结果图">{current.searchImage !== false ? '带封面图片' : '文字列表'}</StatusRow><StatusRow label="评论长图">{current.commentImage !== false ? '先发评论，再发视频' : '只发视频'}</StatusRow></div></div>
      <div className="action-row integration-card-actions"><Button onClick={() => setEditor('watch')}><Settings2 size={19} />本表设置</Button><Button variant="secondary" onClick={() => navigate('chat')}><Play size={19} />进入聊天</Button></div>
    </>}
  </Card>
  <div className="integration-bili-workspace"><Card title="搜索与预览" description="这里只查询和预览结果，不会发送到手表。" className="integration-search-card">
    <form className="stack" onSubmit={(event) => { event.preventDefault(); search(); }}><Field label="视频关键词"><Input placeholder="输入感兴趣的视频主题" value={keyword} onChange={(event) => setKeyword(event.target.value)} /></Field><div className="action-row"><Button type="submit" disabled={searching}><Search size={16} />{searching ? '搜索中…' : '测试搜索'}</Button><Button type="button" variant="secondary" onClick={() => {
      if (!keyword.trim()) { toast('请输入搜索关键词', 'error'); return; }
      setSearchImage('/api/bili/search/preview?kw=' + encodeURIComponent(keyword.trim()) + '&t=' + Date.now());
    }}><Image size={16} />预览搜索图</Button></div></form>
    {searchError && <p className="integration-error" role="alert">{searchError}</p>}
    {searchResult && <div className="integration-search-results"><p className="muted">{searchResult.keyword} · {searchResult.list?.length || 0} 条结果</p>{(searchResult.list || []).map((result: any, index: number) => <div key={result.bvid || result.index || index}><strong>{result.index || index + 1}. {result.title}</strong><small className="muted">{result.author || '未知作者'}{result.duration ? ` · ${result.duration}` : ''}</small></div>)}</div>}
    {searchImage && <PreviewImage key={searchImage} url={searchImage} label="搜索图" />}
  </Card><Card title="评论长图" description="账号级设置，所有手表共用。" className="integration-comment-card" action={<Button variant="secondary" onClick={() => setEditor('comment')}>设置</Button>}>
    <StatusRow label="B 站登录凭证">{data.comment?.sessdata ? '已设置' : '未设置，仅读取热门评论'}</StatusRow><StatusRow label="评论数量上限">{data.comment?.maxComments || 60} 条</StatusRow><StatusRow label="长图高度上限">{data.comment?.maxHeight || 12000} px</StatusRow>
    <div className="stack"><Field label="视频 BV 号"><Input placeholder="BV1xx411c7mD" value={bvid} onChange={(event) => setBvid(event.target.value)} /></Field><Button variant="secondary" onClick={() => {
      if (!/^BV[0-9A-Za-z]{8,12}$/.test(bvid.trim())) { toast('请输入有效的 BV 视频编号', 'error'); return; }
      setCommentImage('/api/bili/comment/preview?bvid=' + encodeURIComponent(bvid.trim()) + '&t=' + Date.now());
    }}><Image size={16} />生成评论预览</Button></div>
    {commentImage && <PreviewImage key={commentImage} url={commentImage} label="评论长图" />}
  </Card></div>
  <Card title="微聊中的点播指令"><div className="integration-api-list"><div><code>/搜索 关键词</code><span>搜索前 10 条视频，返回图片或文字列表</span></div><div><code>/播放 序号</code><span>点播搜索结果；单聊搜索后也可以直接发送数字</span></div><div><code>/评论 [序号]</code><span>查看指定结果，或最近一次点播视频的评论</span></div></div><p className="muted integration-note">搜索结果保留 30 分钟，单聊与家庭群分别记录。超过 30 秒的视频会按手表限制自动分段。</p></Card>
  {!!editor && <BiliEditor key={watchId + editor} initialTab={editor} data={data} current={current} watchId={watchId} onClose={() => setEditor('')} onSaved={resource.reload} />}
  </div>;
}

function BiliEditor({ initialTab, data, current, watchId, onClose, onSaved }: any) {
  const [tab, setTab] = useState(initialTab);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(!!current.enabled);
  const [automatic, setAutomatic] = useState(current.auto !== false);
  const [keys, setKeys] = useState<string[]>(current.keys || []);
  const [minutes, setMinutes] = useState(String((current.maxDuration ?? 600) / 60));
  const [megabytes, setMegabytes] = useState(String(Math.round((current.maxBytes ?? 104857600) / 1024 / 1024)));
  const [daily, setDaily] = useState(String(current.maxPerDay ?? 20));
  const [comments, setComments] = useState(current.commentImage !== false);
  const [images, setImages] = useState(current.searchImage !== false);
  const [sessdata, setSessdata] = useState(data.comment?.sessdata || '');
  const [maxComments, setMaxComments] = useState(String(data.comment?.maxComments || 60));
  const [maxHeight, setMaxHeight] = useState(String(data.comment?.maxHeight || 12000));
  const save = async () => {
    if (tab === 'watch' && (!watchId || (!automatic && !keys.length))) { toast('请选择手表和会话，或使用自动匹配', 'error'); return; }
    setBusy(true);
    try {
      if (tab === 'comment') await post('/api/bili/comment', { sessdata, maxComments: Number(maxComments) || 60, maxHeight: Number(maxHeight) || 12000 });
      else await post('/api/bili/watch', { watchId, enabled, targets: automatic ? [] : keys,
        maxDuration: Math.max(0, Math.min(120, Number(minutes) || 0)) * 60,
        maxBytes: Math.max(0, Math.min(100, Number(megabytes) || 0)) * 1024 * 1024,
        maxPerDay: Math.max(0, Math.min(999, Number(daily) || 0)), commentImage: comments, searchImage: images });
      await onSaved(); toast(tab === 'comment' ? '评论长图设置已保存' : '本表点播设置已保存', 'success'); onClose();
    } catch (error: any) { toast(error.message || '保存失败', 'error'); }
    finally { setBusy(false); }
  };
  return <Modal open onClose={() => { if (!busy) onClose(); }} closeable={!busy} className="integration-dialog" title="B 站点播设置" size="lg" footer={<><Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button><Button loading={busy} onClick={save}>{busy ? '保存中…' : '保存设置'}</Button></>}>
    <fieldset className="stack integration-editor-fieldset" disabled={busy}><Tabs items={[...(watchId ? [{ value: 'watch', label: '本表点播', disabled: busy }] : []), { value: 'comment', label: '评论长图', disabled: busy }]} value={tab} onChange={setTab} />
    {tab === 'comment' ? <><p className="muted integration-note">填写浏览器登录 B 站后的 SESSDATA，可读取更多评论。留空时仅获取公开热门评论。</p><Field label="SESSDATA"><Input type="password" autoComplete="off" placeholder="可留空" value={sessdata} onChange={(event) => setSessdata(event.target.value)} /></Field><div className="grid-2"><Field label="最多抓取评论数"><Input type="number" min={10} max={300} value={maxComments} onChange={(event) => setMaxComments(event.target.value)} /></Field><Field label="长图最高像素"><Input type="number" min={2000} max={20000} value={maxHeight} onChange={(event) => setMaxHeight(event.target.value)} /></Field></div></> : <>
      <Toggle label={`为 ${current.name || watchId} 启用点播`} checked={enabled} onChange={setEnabled} />
      <section className="integration-section"><h3>响应会话</h3><SessionPicker targets={data.targets || []} selected={keys} onChange={setKeys} automatic={automatic} onAutomaticChange={setAutomatic} disabled={busy} /></section>
      <div className="grid-3"><Field label="时长上限（分钟）" hint="0 表示不限，最多 120。"><Input type="number" min={0} max={120} value={minutes} onChange={(event) => setMinutes(event.target.value)} /></Field><Field label="大小上限（MB）" hint="0 表示不限，最多 100。"><Input type="number" min={0} max={100} value={megabytes} onChange={(event) => setMegabytes(event.target.value)} /></Field><Field label="每天最多点播" hint="0 表示不限。"><Input type="number" min={0} max={999} value={daily} onChange={(event) => setDaily(event.target.value)} /></Field></div>
      <Toggle label="点播时先发评论区长图" checked={comments} onChange={setComments} /><Toggle label="搜索结果使用带封面的图片" checked={images} onChange={setImages} />
      <p className="muted integration-note">搜索图生成失败时会自动回退为文字结果。</p>
    </>}
    </fieldset>
  </Modal>;
}
