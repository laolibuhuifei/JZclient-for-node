import React, { useEffect, useState } from 'react';
import { Check, Copy, Eye, EyeOff, MessageCircle, RefreshCw, Users } from 'lucide-react';
import { Button, EmptyState, Modal, Toggle, toast } from '../ui';

export function timeLabel(value: any) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  const date = new Date(Number.isFinite(number) ? (number < 1e12 ? number * 1000 : number) : value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
}

export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand('copy')) throw new Error('无法复制，请手动选择文字');
  } finally {
    textarea.remove();
  }
}

export function CopyValue({ label, value, secret = false }: { label: string; value: any; secret?: boolean }) {
  const [visible, setVisible] = useState(!secret);
  const [copied, setCopied] = useState(false);
  const text = String(value ?? '');
  useEffect(() => { setCopied(false); }, [text]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <div className="integration-copy-row">
    <span className="muted">{label}</span>
    <div className="integration-copy-value">
      <code title={visible ? text : undefined}>{visible ? (text || '—') : '••••••••••••••••'}</code>
      {secret && <Button variant="ghost" size="icon" aria-label={visible ? `隐藏${label}` : `显示${label}`} onClick={() => setVisible(!visible)}>
        {visible ? <EyeOff size={19} /> : <Eye size={19} />}
      </Button>}
      <Button variant="ghost" size="icon" disabled={!text} aria-label={`复制${label}`} onClick={async () => {
        try { await copyText(text); setCopied(true); toast('已复制', 'success'); }
        catch (error: any) { toast(error.message || '复制失败', 'error'); }
      }}>{copied ? <Check size={19} /> : <Copy size={19} />}</Button>
    </div>
  </div>;
}

export function StatusRow({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <div className="integration-status-row"><span className="muted">{label}</span><span>{children}</span></div>;
}

export function SessionPicker({ targets, selected, onChange, automatic, onAutomaticChange, disabled = false }: {
  targets: any[]; selected: string[]; onChange: (keys: string[]) => void;
  automatic: boolean; onAutomaticChange: (automatic: boolean) => void; disabled?: boolean;
}) {
  const known = new Set(targets.map((target) => String(target.key)));
  const all = [...targets, ...selected.filter((key) => !known.has(key)).map((key) => ({ key, name: '已保存的会话', type: key.startsWith('g:') ? 'group' : 'single' }))];
  return <div className="stack">
    <Toggle label="按当前手表自动匹配会话" checked={automatic} onChange={onAutomaticChange} disabled={disabled} />
    {automatic ? <p className="muted integration-note">根据手表匹配单聊和家庭群。没有匹配到时暂不收发，可以切换为手动指定。</p> :
      <div className="integration-session-list">
        {all.length ? all.map((target) => <label className="integration-session" key={target.key}>
          <input type="checkbox" checked={selected.includes(String(target.key))} disabled={disabled} onChange={(event) => onChange(event.target.checked
            ? [...new Set([...selected, String(target.key)])] : selected.filter((key) => key !== String(target.key)))} />
          <span className="integration-session-icon" aria-hidden="true">{target.type === 'group' ? <Users size={20} /> : <MessageCircle size={20} />}</span>
          <span><strong>{target.name || target.key}</strong><small className="muted">{target.type === 'group' ? '家庭群' : '单聊'} · {target.key}</small></span>
        </label>) : <EmptyState title="还没有会话" description="登录家长端账号后刷新会话列表，再选择要接入的会话。" />}
      </div>}
  </div>;
}

export function ConfirmAction({ title, description, label, onConfirm, variant = 'danger', disabled = false }: {
  title: string; description: string; label: string; onConfirm: () => Promise<any>;
  variant?: 'danger' | 'secondary' | 'primary' | 'ghost'; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return <><Button variant={variant} disabled={disabled} onClick={() => setOpen(true)}>{label}</Button>
    <Modal open={open} onClose={() => { if (!busy) setOpen(false); }} closeable={!busy} className="integration-dialog" title={title} description={description}
      footer={<><Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button variant={variant} loading={busy} onClick={async () => {
        setBusy(true);
        try { await onConfirm(); setOpen(false); }
        catch (error: any) { toast(error.message || '操作失败', 'error'); }
        finally { setBusy(false); }
      }}>{busy ? '处理中…' : '确认'}</Button></>}><p className="muted">{description}</p></Modal>
  </>;
}

export function PreviewImage({ url, label }: { url: string; label: string }) {
  const [size, setSize] = useState('');
  const [failed, setFailed] = useState(false);
  return <div className="integration-preview">
    {!size && !failed && <div className="row muted"><RefreshCw size={16} className="spin" />正在生成{label}…</div>}
    {failed ? <p role="alert">生成失败，请检查视频编号或关键词，并在运行日志中查看原因。</p> :
      <div className="integration-preview-image-scroll"><img src={url} alt={label} onLoad={(event) => { const image = event.currentTarget; setSize(`${image.naturalWidth} × ${image.naturalHeight}`); }} onError={() => setFailed(true)} /></div>}
    {size && <div className="row"><span className="muted">{label} · {size} 像素</span><a href={url} target="_blank" rel="noopener noreferrer">打开原图</a></div>}
  </div>;
}
