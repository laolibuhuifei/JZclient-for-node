import React, { useEffect, useRef, useState } from 'react';
import { Mic, RotateCcw, Send, Square } from 'lucide-react';
import { Button, Field, Input, Tabs, toast } from '../ui';

type Props = {
  busy: boolean; onClose: () => void;
  onRecording: (blob: Blob, duration: number) => Promise<boolean>;
  onSend: (kind: string, extra: any) => Promise<boolean>;
};

export default function Recorder({ busy, onClose, onRecording, onSend }: Props) {
  const [mode, setMode] = useState('record');
  const [status, setStatus] = useState<'idle' | 'starting' | 'recording' | 'ready'>('idle');
  const [seconds, setSeconds] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [preview, setPreview] = useState('');
  const [url, setUrl] = useState('');
  const [duration, setDuration] = useState('');
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const startedAt = useRef(0);
  const alive = useRef(true);

  function releaseTracks() { stream.current?.getTracks().forEach(track => track.stop()); stream.current = null; }

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (recorder.current) {
        recorder.current.onstop = null;
        recorder.current.ondataavailable = null;
        if (recorder.current.state !== 'inactive') recorder.current.stop();
      }
      releaseTracks();
    };
  }, []);

  useEffect(() => {
    if (status !== 'recording') return;
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - startedAt.current) / 1000)), 250);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (!blob) { setPreview(''); return; }
    const objectUrl = URL.createObjectURL(blob);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  async function start() {
    if (status === 'starting' || status === 'recording' || busy) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast('当前浏览器不支持录音，请使用 HTTPS 或本机 localhost 访问，并允许麦克风权限', 'error');
      return;
    }
    setStatus('starting');
    try {
      const active = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { active.getTracks().forEach(track => track.stop()); return; }
      stream.current = active;
      const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
      const next = mime ? new MediaRecorder(active, { mimeType: mime }) : new MediaRecorder(active);
      const chunks: Blob[] = [];
      let totalSize = 0;
      recorder.current = next;
      setBlob(null);
      setSeconds(0);
      startedAt.current = Date.now();
      next.ondataavailable = event => {
        if (!event.data?.size) return;
        chunks.push(event.data);
        totalSize += event.data.size;
        if (totalSize > 5 * 1024 * 1024 && next.state === 'recording') next.stop();
      };
      next.onerror = () => {
        releaseTracks();
        if (alive.current) { setStatus('idle'); toast('录音中断，请重试', 'error'); }
      };
      next.onstop = () => {
        releaseTracks();
        if (!alive.current) return;
        const recording = new Blob(chunks, { type: next.mimeType || 'audio/webm' });
        if (recording.size < 400) { setStatus('idle'); toast('录音太短，请重新录制', 'error'); return; }
        if (recording.size > 5 * 1024 * 1024) { setStatus('idle'); toast('录音文件超过 5MB，请分次录制', 'error'); return; }
        setSeconds(Math.max(1, Math.round((Date.now() - startedAt.current) / 1000)));
        setBlob(recording);
        setStatus('ready');
      };
      next.start(1000);
      setStatus('recording');
    } catch (error: any) {
      releaseTracks();
      if (alive.current) { setStatus('idle'); toast('无法录音：' + error.message, 'error'); }
    }
  }

  async function sendUrl(event: React.FormEvent) {
    event.preventDefault();
    try { const parsed = new URL(url.trim()); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(); }
    catch { toast('请输入有效的音频链接', 'error'); return; }
    if (await onSend('voice', { src: url.trim(), duration: Number(duration) || 0 })) onClose();
  }

  const active = status === 'recording' || status === 'starting';
  return <div className="chat-recorder-form stack">
    <Tabs items={[{ value: 'record', label: '录制语音', disabled: active || busy }, { value: 'url', label: '音频链接', disabled: active || busy }]} value={mode} onChange={value => { if (!active && !busy) setMode(value); }} />
    {mode === 'record' ? <>
      <div className="chat-recorder">
        <div className={`chat-record-icon ${status === 'recording' ? 'is-recording' : ''}`} aria-hidden="true"><Mic size={34} /></div>
        <div className="chat-record-time" role="timer" aria-label="录音时长" aria-live="off">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</div>
        <p className="muted" role="status">{status === 'recording' ? '正在录音，停止后可试听' : status === 'starting' ? '正在请求麦克风权限…' : status === 'ready' ? '录音已就绪，试听后发送' : '点击开始，录一段想说的话'}</p>
        {preview && <audio src={preview} controls preload="metadata" />}
        {status === 'recording' ? <Button variant="danger" onClick={() => recorder.current?.stop()}><Square size={18} aria-hidden="true" />停止录音</Button> : <Button variant="secondary" loading={status === 'starting'} aria-busy={status === 'starting'} disabled={busy || status === 'starting'} onClick={start}>{status !== 'starting' && (status === 'ready' ? <RotateCcw size={18} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />)}{status === 'starting' ? '等待麦克风…' : status === 'ready' ? '重新录制' : '开始录音'}</Button>}
      </div>
      <div className="chat-help-note">超过 58 秒的语音会自动分段发送，最多 20 段。关闭窗口会停止录音；只有点击发送才会发送给对方。</div>
      <div className="chat-composer-actions action-row"><Button variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button disabled={busy || status !== 'ready' || !blob} aria-busy={busy} onClick={async () => { if (blob && await onRecording(blob, seconds)) onClose(); }}><Send size={18} aria-hidden="true" />{busy ? '转码并发送中…' : '发送语音'}</Button></div>
    </> : <form className="stack" onSubmit={sendUrl}>
      <Field label="音频地址"><Input type="url" required placeholder="https://" value={url} onChange={event => setUrl(event.target.value)} disabled={busy} /></Field>
      <Field label="时长（秒）" hint="可留空，由服务端读取。"><Input type="number" min="0" value={duration} onChange={event => setDuration(event.target.value)} disabled={busy} /></Field>
      <div className="chat-help-note">服务端会下载、转码并自动分段；无法下载时，仅 AMR / Opus 外链可直接发送。</div>
      <div className="chat-composer-actions action-row"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" disabled={busy} aria-busy={busy}><Send size={18} aria-hidden="true" />{busy ? '处理并发送中…' : '发送语音'}</Button></div>
    </form>}
  </div>;
}
