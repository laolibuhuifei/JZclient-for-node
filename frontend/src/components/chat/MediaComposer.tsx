import React, { useEffect, useRef, useState } from 'react';
import { FileImage, Film, Send, UploadCloud, X } from 'lucide-react';
import { Button, Field, Input, Tabs, toast } from '../ui';

type Props = {
  kind: 'image' | 'video'; busy: boolean; onClose: () => void;
  onUpload: (file: File, kind: 'image' | 'video') => Promise<boolean>;
  onSend: (kind: string, extra: any) => Promise<boolean>;
};

export default function MediaComposer({ kind, busy, onClose, onUpload, onSend }: Props) {
  const [mode, setMode] = useState('file');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const label = kind === 'video' ? '视频' : '图片';

  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const source = URL.createObjectURL(file);
    setPreview(source);
    return () => URL.revokeObjectURL(source);
  }, [file]);

  function chooseFile(next?: File) {
    if (!next) return;
    if (next.size > 100 * 1024 * 1024) { toast('文件不能超过 100MB', 'error'); return; }
    if (!next.size) { toast('不能发送空文件', 'error'); return; }
    const expected = kind === 'video' ? 'video/' : 'image/';
    if (next.type && !next.type.startsWith(expected)) { toast(`请选择${label}文件`, 'error'); return; }
    setFile(next);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (mode === 'file') {
      if (!file) { toast(`请先选择${label}`, 'error'); return; }
      if (await onUpload(file, kind)) onClose();
    } else {
      try { const parsed = new URL(url.trim()); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
      catch { toast('请输入以 http:// 或 https:// 开头的有效地址', 'error'); return; }
      if (await onSend(kind, { src: url.trim(), ...(kind === 'video' ? { duration: Number(duration) || 0 } : {}) })) onClose();
    }
  }

  return <form className="chat-media-form stack" onSubmit={submit}>
    <Tabs items={[{ value: 'file', label: '本地文件', disabled: busy }, { value: 'url', label: '网络链接', disabled: busy }]} value={mode} onChange={value => { if (!busy) setMode(value); }} />
    {mode === 'file' ? <>
      <input ref={input} hidden type="file" accept={kind === 'video' ? 'video/*' : 'image/*'} disabled={busy} onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
      {file ? <div className="chat-file-selected">
        {preview && (kind === 'image' ? <img className="chat-upload-preview" src={preview} alt="待发送的图片" /> : <video className="chat-upload-preview" src={preview} controls preload="metadata" />)}
        <div className="row"><div><strong>{file.name}</strong><div className="muted">{(file.size / 1024 / 1024).toFixed(2)} MB</div></div><Button type="button" variant="ghost" size="icon" disabled={busy} aria-label="移除文件" onClick={() => setFile(null)}><X size={20} aria-hidden="true" /></Button></div>
      </div> : <button className="chat-upload-zone" type="button" disabled={busy} onClick={() => input.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) chooseFile(event.dataTransfer.files[0]); }}>
        <span className="chat-upload-icon">{kind === 'video' ? <Film size={28} /> : <FileImage size={28} />}</span><strong>选择或拖入{label}</strong><span className="muted">支持最大 100MB 的文件</span><span className="chat-upload-prompt"><UploadCloud size={16} />选择文件</span>
      </button>}
    </> : <>
      <Field label={`${label}地址`}><Input required type="url" placeholder="https://" value={url} onChange={event => setUrl(event.target.value)} disabled={busy} /></Field>
      {kind === 'video' && <Field label="视频时长（秒）" hint="超过 30 秒时会下载并自动切分；直链请填写真实时长。"><Input type="number" min="0" step="1" value={duration} onChange={event => setDuration(event.target.value)} placeholder="可选" disabled={busy} /></Field>}
    </>}
    {kind === 'video' && <div className="chat-help-note">本地视频超过 30 秒会自动分段，最多 30 段。处理和发送可能需要一些时间，请等待结果。</div>}
    <div className="chat-composer-actions action-row"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy || (mode === 'file' && !file)} aria-busy={busy}><Send size={18} aria-hidden="true" />{busy ? '处理并发送中…' : `发送${label}`}</Button></div>
  </form>;
}
