import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  Activity, Bot, FlaskConical, Image, MessageSquare, Play, RefreshCw,
  ScrollText, Search, Settings2, Square, Users,
} from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import {
  Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState,
  Modal, PageHeader, Select, Textarea, Toggle, toast,
} from '../components/ui';
import '../components/integrations/ai.css';

type AiConfig = {
  baseUrl?: string;
  model?: string;
  hasKey?: boolean;
  apiKeyMask?: string;
  temperature?: number;
  trigger?: string;
  keywords?: string[];
  keywordsMode?: string;
  timeoutMs?: number;
  systemPrompt?: string;
  vision?: boolean;
  visionMaxBytes?: number;
  visionPrompt?: string;
};

type AiTarget = { key: string; type: string; name: string; sub?: string; enabled?: boolean };
type AiState = {
  managed?: boolean;
  source?: string;
  running?: boolean;
  autoStart?: boolean;
  connected?: boolean;
  config?: AiConfig;
  targets?: AiTarget[];
  sessions?: unknown[];
  diagnostics?: { chatTargets?: number; sessions?: number; hasBaseUrl?: boolean; hasKey?: boolean; model?: string };
};
type Editor = 'config' | 'trigger' | 'vision' | 'prompt' | null;
type ModelTest = { model?: string; ms?: number; reply?: string };

const MATCH_LABELS: Record<string, string> = {
  auto: '前缀优先与词边界包含', prefix: '仅匹配前缀', contains: '包含关键词',
};
const MODAL_TITLES: Record<Exclude<Editor, null>, string> = {
  config: 'AI 接口配置', trigger: '触发方式', vision: '识图设置', prompt: '系统提示词',
};
const loadAi = (signal?: AbortSignal) => api('/api/ai', { signal });

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '操作失败，请重试');
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ai-detail">
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>;
}

export default function AiPage() {
  const { navigate } = useApp();
  const { data: result, loading, error, reload } = useResource(loadAi, [], 15000);
  const data = result as AiState | undefined;
  const config = data?.config || {};
  const targets = data?.targets || [];
  const [editor, setEditor] = useState<Editor>(null);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [pending, setPending] = useState('');
  const [actionError, setActionError] = useState('');
  const [formError, setFormError] = useState('');
  const [testResult, setTestResult] = useState<ModelTest | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [sessionsDirty, setSessionsDirty] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (data && !sessionsDirty) setSelected((data.targets || []).filter((target) => target.enabled).map((target) => target.key));
  }, [data, sessionsDirty]);

  const shownTargets = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return targets.filter((target) => !search || `${target.name} ${target.sub || ''} ${target.key}`.toLocaleLowerCase().includes(search));
  }, [targets, query]);

  function openEditor(next: Exclude<Editor, null>) {
    setFormError('');
    setDraft(next === 'config' ? {
      baseUrl: config.baseUrl || '', apiKey: '', model: config.model || 'gpt-4o-mini',
      temperature: config.temperature ?? 0.7,
    } : next === 'trigger' ? {
      trigger: config.trigger || 'auto', keywords: (config.keywords || []).join(', '),
      keywordsMode: config.keywordsMode || 'auto',
    } : next === 'vision' ? {
      vision: config.vision !== false,
      visionMaxMB: Math.round((config.visionMaxBytes || 4194304) / 1048576 * 100) / 100,
      visionPrompt: config.visionPrompt || '',
    } : { systemPrompt: config.systemPrompt || '' });
    setEditor(next);
  }

  async function changeRunning() {
    const action = data?.running ? 'stop' : 'start';
    setPending(action);
    setActionError('');
    try {
      await post(`/api/ai/${action}`, {});
      toast(action === 'start' ? 'AI 已启动，下次重启服务后会自动恢复' : 'AI 已停止，下次重启服务后不会自动启动');
      await reload();
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setPending('');
    }
  }

  async function testModel() {
    setPending('test');
    setActionError('');
    setTestResult(null);
    try {
      const tested = await post('/api/ai/test', {});
      setTestResult(tested as ModelTest);
      toast('模型接口自检成功');
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setPending('');
    }
  }

  function toggleSession(key: string, checked: boolean) {
    setSessionsDirty(true);
    setSelected((current) => checked ? [...new Set([...current, key])] : current.filter((value) => value !== key));
  }

  async function saveSessions() {
    setPending('sessions');
    setActionError('');
    try {
      const saved = await post('/api/ai/sessions', { keys: selected });
      if (saved.missed?.length) {
        setActionError(`已启用 ${saved.count} 个会话；${saved.missed.length} 个会话未匹配，请刷新会话列表后重新选择。`);
      } else {
        toast(`已启用 ${saved.count} 个会话`);
      }
      await reload();
      setSessionsDirty(false);
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setPending('');
    }
  }

  async function saveEditor(event: FormEvent) {
    event.preventDefault();
    if (!editor) return;
    setFormError('');
    let body = { ...draft };
    if (editor === 'config') {
      if (data?.managed) return;
      try {
        const url = new URL(String(draft.baseUrl || '').trim());
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      } catch {
        setFormError('请输入以 http:// 或 https:// 开头的完整接口地址');
        return;
      }
      if (!String(draft.model || '').trim()) {
        setFormError('请填写模型名称');
        return;
      }
      const temperature = Number(draft.temperature);
      if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
        setFormError('温度应为 0 到 2 之间的数字');
        return;
      }
      body = { ...draft, baseUrl: String(draft.baseUrl).trim(), model: String(draft.model).trim(), temperature };
    } else if (editor === 'vision') {
      const megabytes = Number(draft.visionMaxMB);
      if (!Number.isFinite(megabytes) || megabytes < 0.25 || megabytes > 5) {
        setFormError('单张图片上限应为 0.25 到 5 MB');
        return;
      }
      body = {
        vision: draft.vision === true, visionMaxBytes: Math.round(megabytes * 1048576),
        visionPrompt: draft.visionPrompt || '',
      };
    }
    setPending('editor');
    try {
      const saved = await post(`/api/ai/${editor}`, body);
      toast(editor === 'trigger' ? `触发方式已保存，共 ${saved.keywords?.length || 0} 个关键词` : '设置已保存');
      setEditor(null);
      await reload();
    } catch (failure) {
      setFormError(errorMessage(failure));
    } finally {
      setPending('');
    }
  }

  const updateDraft = (key: string, value: any) => setDraft((current) => ({ ...current, [key]: value }));
  const busy = Boolean(pending);

  const pageHeader = <PageHeader title="AI 助手" description="管理自动回复、会话范围和模型设置。" actions={<>
    <Button variant="ghost" onClick={() => navigate('logs')}><ScrollText size={19} />运行日志</Button>
    <Button variant="secondary" size="icon" onClick={() => reload()} disabled={loading || busy} aria-label="刷新 AI 状态" title="刷新 AI 状态"><RefreshCw size={20} /></Button>
  </>} />;

  if (!data && loading) return <div className="stack ai-page">{pageHeader}<Card title="AI 助手状态"><LoadingState text="正在读取 AI 配置与会话…" /></Card></div>;
  if (!data && error) return <div className="stack ai-page">{pageHeader}<ErrorState error={error} onRetry={reload} /></div>;

  return <div className="stack ai-page">
    {pageHeader}

    {error && data && <ErrorState error={error} onRetry={reload} />}
    {actionError && <ErrorState error={actionError} />}

    <div className="ai-status-grid">
      <Card className="ai-running-card" title="自动回复" action={<Badge tone={data?.running ? 'success' : 'neutral'}>{data?.running ? '运行中' : '已停止'}</Badge>}>
        <div className="ai-running-content">
          <span className="ai-service-icon" aria-hidden="true"><Bot size={32} strokeWidth={1.6} /></span>
          <div className="ai-running-copy"><p className="ai-running-title">{data?.running ? 'AI 助手正在运行' : 'AI 助手尚未启动'}</p>
            <p>{config.trigger === 'keyword' ? `匹配 ${(config.keywords || []).length} 个关键词后回复` : '自动回复所选会话中的文本消息'}</p>
            <p className="ai-restart-note">重启服务后{data?.autoStart === false ? '不会自动启动' : '会自动恢复运行'}。</p>
          </div>
        </div>
        <div className="action-row ai-running-actions">
          <Button variant={data?.running ? 'secondary' : 'primary'} onClick={changeRunning} disabled={busy} aria-busy={pending === 'start' || pending === 'stop'}>
            {data?.running ? <Square size={18} /> : <Play size={18} />}
            {pending === 'start' ? '正在启动…' : pending === 'stop' ? '正在停止…' : data?.running ? '停止 AI' : '启动 AI'}
          </Button>
          <Button variant="ghost" onClick={() => openEditor('trigger')} disabled={busy}><Settings2 size={18} />设置触发方式</Button>
        </div>
      </Card>
      <Card className="ai-connection-card" title="消息与会话" action={<Activity size={23} aria-hidden="true" />}>
        <dl className="ai-details">
          <Detail label="消息连接"><Badge tone={data?.connected ? 'success' : 'warning'}>{data?.connected ? '已连接' : '未连接'}</Badge></Detail>
          <Detail label="可用会话">{data?.diagnostics?.chatTargets ?? targets.length} 个</Detail>
          <Detail label="已启用会话">{(data?.sessions || []).length} 个</Detail>
        </dl>
        <p className="ai-note">IM 连接建立后，AI 才能接收手表消息。</p>
        <Button variant="ghost" onClick={() => navigate('chat')}><MessageSquare size={18} />查看聊天</Button>
      </Card>
    </div>

    <div className="ai-workspace-grid">
    <Card className="ai-session-card" title="启用 AI 的会话" description="只在选中的单聊和家庭群中自动回复。" action={<Button onClick={saveSessions} disabled={busy || !sessionsDirty} aria-busy={pending === 'sessions'}>{pending === 'sessions' ? '正在保存…' : '保存会话'}</Button>}>
      <div className="ai-session-content">
        <div className="ai-session-toolbar">
          <div className="ai-session-search">
            <Search size={20} aria-hidden="true" />
            <Input aria-label="搜索 AI 会话" placeholder="搜索会话名称" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="ai-session-selection">
            <span className="ai-selection-count" role="status">已选择 {selected.length} 个{sessionsDirty ? ' · 尚未保存' : ''}</span>
            <div className="action-row">
            <Button variant="ghost" disabled={busy || !shownTargets.length} onClick={() => {
              setSessionsDirty(true);
              setSelected((current) => [...new Set([...current, ...shownTargets.map((target) => target.key)])]);
            }}>全选</Button>
            <Button variant="ghost" disabled={busy || !selected.length} onClick={() => { setSessionsDirty(true); setSelected([]); }}>清空</Button>
            </div>
          </div>
        </div>
        {!targets.length ? <EmptyState title="暂无可用会话" description="登录手表账号后，单聊和家庭群会显示在这里。" action={<Button variant="secondary" onClick={() => navigate('account')}>查看账号</Button>} />
          : !shownTargets.length ? <EmptyState title="没有匹配的会话" description="换一个名称搜索，或清空搜索条件。" />
            : <div className="ai-session-list">
              {shownTargets.map((target) => <label key={target.key} className="ai-session-option" data-selected={selected.includes(target.key)} data-disabled={busy}>
                <input type="checkbox" checked={selected.includes(target.key)} onChange={(event) => toggleSession(target.key, event.target.checked)} disabled={busy} />
                <span className="ai-session-icon" aria-hidden="true">{target.type === 'group' ? <Users size={21} /> : <MessageSquare size={21} />}</span>
                <span className="ai-session-name">
                  <strong>{target.name || target.key}</strong>
                  <small>{target.type === 'group' ? '家庭群' : '单聊'}{target.sub ? ` · ${target.sub}` : ''}</small>
                </span>
              </label>)}
            </div>}
      </div>
    </Card>
      <div className="ai-settings-stack">
      <Card className="ai-model-card" title="模型与接口" action={<Badge tone={data?.managed ? 'info' : 'neutral'}>{data?.managed ? data.source === 'platform' ? '官方 AI' : '自带密钥' : '自行配置'}</Badge>}>
        <dl className="ai-details">
          <Detail label="模型">{config.model || '未设置'}</Detail>
          <Detail label="温度">{config.temperature ?? '—'}</Detail>
          {config.timeoutMs != null && <Detail label="请求超时">{Math.round(config.timeoutMs / 1000)} 秒</Detail>}
          {!data?.managed && <>
            <Detail label="请求地址">{config.baseUrl || '未配置'}</Detail>
            <Detail label="API Key"><span className="mono">{config.hasKey ? config.apiKeyMask : '未设置'}</span></Detail>
          </>}
        </dl>
          {data?.managed && <p className="ai-note">
            {data.source === 'platform'
              ? '接口由云端平台提供。配额和用量可以在平台的「微聊 AI」页面查看。'
              : '密钥在平台的「微聊 AI」页面设置。请求由当前实例直连上游服务。'}
          </p>}
          <div className="action-row ai-model-actions">
            {!data?.managed && <Button variant="secondary" onClick={() => openEditor('config')} disabled={busy}><Settings2 size={18} />修改接口</Button>}
            <Button variant="ghost" onClick={testModel} disabled={busy} aria-busy={pending === 'test'}><FlaskConical size={18} />{pending === 'test' ? '正在自检…' : '自检（直连模型）'}</Button>
          </div>
          {testResult && <div className="ai-test-result" role="status">
            <div className="ai-test-result-heading">
              <Badge tone="success">接口正常</Badge>
              <span className="muted">{testResult.model || config.model} · {testResult.ms ?? '—'} ms</span>
            </div>
            <p>{testResult.reply || '模型已返回响应'}</p>
          </div>}
      </Card>

      <Card className="ai-trigger-card" title="触发与识图" action={<Settings2 size={23} aria-hidden="true" />}>
        <dl className="ai-details">
          <Detail label="回复模式">{config.trigger === 'keyword' ? '关键词触发' : '自动回复'}</Detail>
          <Detail label="匹配方式">{MATCH_LABELS[config.keywordsMode || 'auto'] || MATCH_LABELS.auto}</Detail>
          <Detail label="关键词">{(config.keywords || []).join(' / ') || '未设置'}</Detail>
          <Detail label="图片识别"><Badge tone={config.vision !== false ? 'success' : 'neutral'}>{config.vision !== false ? '已开启' : '已关闭'}</Badge></Detail>
          {config.vision !== false && <>
            <Detail label="单图上限">{Math.round((config.visionMaxBytes || 4194304) / 1048576 * 100) / 100} MB</Detail>
          </>}
        </dl>
        {config.vision !== false && <p className="ai-note">关键词模式下，纯图片不会触发回复；图片附带文字时，按文字判断，并将图片一起交给模型。</p>}
        <div className="action-row ai-model-actions"><Button variant="secondary" onClick={() => openEditor('trigger')} disabled={busy}>编辑触发</Button><Button variant="ghost" onClick={() => openEditor('vision')} disabled={busy}><Image size={18} />识图设置</Button></div>
      </Card>
      </div>

    </div>

    <Card className="ai-prompt-card" title="系统提示词" description="定义助手的角色、语气和回答方式。" action={<Button variant="secondary" onClick={() => openEditor('prompt')} disabled={busy}><ScrollText size={18} />编辑提示词</Button>}>
      <p className="ai-prompt-content">{config.systemPrompt || '尚未设置系统提示词'}</p>
    </Card>

    <Modal className="ai-editor-dialog" open={editor !== null} closeable={pending !== 'editor'} onClose={() => { if (pending !== 'editor') setEditor(null); }} title={editor ? MODAL_TITLES[editor] : ''} size={editor === 'prompt' ? 'lg' : 'md'} footer={<>
      <Button variant="secondary" onClick={() => setEditor(null)} disabled={pending === 'editor'}>取消</Button>
      <Button type="submit" form="ai-settings-form" disabled={pending === 'editor'}>{pending === 'editor' ? '正在保存…' : '保存设置'}</Button>
    </>}>
      <form id="ai-settings-form" onSubmit={saveEditor}>
        <fieldset className="ai-editor-fields" disabled={pending === 'editor'}>
        {formError && <ErrorState error={formError} />}
        {editor === 'config' && <>
          <Field label="请求地址" hint="填写兼容 OpenAI 的 API 地址。">
            <Input required type="url" value={draft.baseUrl || ''} onChange={(event) => updateDraft('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" autoComplete="url" />
          </Field>
          <Field label="API Key" hint="留空保留原来的密钥。">
            <Input type="password" value={draft.apiKey || ''} onChange={(event) => updateDraft('apiKey', event.target.value)} placeholder={config.hasKey ? '已设置，留空保持不变' : '填写 API Key'} autoComplete="new-password" />
          </Field>
          <div className="form-grid">
            <Field label="模型"><Input required value={draft.model || ''} onChange={(event) => updateDraft('model', event.target.value)} placeholder="gpt-4o-mini" /></Field>
            <Field label="温度" hint="0–2，数值越高，回答越有变化。"><Input type="number" min="0" max="2" step="0.1" required value={draft.temperature ?? 0.7} onChange={(event) => updateDraft('temperature', event.target.value)} /></Field>
          </div>
        </>}
        {editor === 'trigger' && <>
          <Field label="回复模式"><Select value={draft.trigger || 'auto'} onChange={(event) => updateDraft('trigger', event.target.value)}>
            <option value="auto">自动回复所有文本</option><option value="keyword">匹配关键词后回复</option>
          </Select></Field>
          <Field label="关键词" hint="用逗号、空格或换行分隔多个关键词。"><Textarea rows={3} value={draft.keywords || ''} onChange={(event) => updateDraft('keywords', event.target.value)} placeholder="例如：小助手, 帮我" /></Field>
          <Field label="关键词匹配方式"><Select value={draft.keywordsMode || 'auto'} onChange={(event) => updateDraft('keywordsMode', event.target.value)}>
            <option value="auto">前缀优先 + 词边界包含（推荐）</option><option value="prefix">只认前缀</option><option value="contains">只认包含</option>
          </Select></Field>
          {draft.trigger === 'keyword' && !String(draft.keywords || '').trim() && <p className="ai-editor-note">当前没有关键词，关键词模式下不会自动回复。</p>}
        </>}
        {editor === 'vision' && <>
          <Toggle checked={draft.vision === true} onChange={(checked) => updateDraft('vision', checked)} label="识别图片消息" />
          <p className="ai-editor-note">需要当前模型支持图片输入。关闭后，图片消息会直接跳过。</p>
          <Field label="单张图片上限（MB）" hint="可设为 0.25–5 MB。图片超出上限时会先尝试压缩。"><Input type="number" min="0.25" max="5" step="0.05" required value={draft.visionMaxMB ?? 4} onChange={(event) => updateDraft('visionMaxMB', event.target.value)} /></Field>
          <Field label="看图提示词" hint="仅在消息带图片时追加到系统提示词之后。"><Textarea rows={5} value={draft.visionPrompt || ''} onChange={(event) => updateDraft('visionPrompt', event.target.value)} /></Field>
        </>}
        {editor === 'prompt' && <Field label="提示词内容"><Textarea rows={12} value={draft.systemPrompt || ''} onChange={(event) => updateDraft('systemPrompt', event.target.value)} placeholder="描述助手应该扮演的角色与回复方式…" /></Field>}
        </fieldset>
      </form>
    </Modal>
  </div>;
}
