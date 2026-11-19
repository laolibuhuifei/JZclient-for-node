import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Download, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { Badge, Button, Modal, toast } from './ui';

export default function CloudUpdate() {
  const [update, setUpdate] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const current = useRef<any>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    let active = true;
    const check = async () => {
      if (current.current) return;
      try {
        const data = await api('/api/update/check?force=1', { timeoutMs: 8000 });
        if (!active || !data?.managed || !data?.hasUpdate) return;
        current.current = data; setUpdate(data);
        let skipped = ''; try { skipped = localStorage.getItem('jz_update_skip') || ''; } catch {}
        setOpen(data.force || skipped !== String(data.latest));
      } catch {}
    };
    const initial = setTimeout(check, 3000); const timer = setInterval(check, 30 * 60 * 1000);
    return () => { active = false; clearTimeout(initial); clearInterval(timer); if (poll.current) clearInterval(poll.current); };
  }, []);
  const later = () => { if (update.force || busy) return; try { localStorage.setItem('jz_update_skip', String(update.latest)); } catch {} setOpen(false); };
  async function apply() {
    setBusy(true);
    try {
      await post('/api/update/apply', {}, { timeoutMs: 12000 }); setWaiting(true);
      const started = Date.now(); let running = false;
      poll.current = setInterval(async () => {
        if (Date.now() - started > 90000) { if (poll.current) clearInterval(poll.current); location.reload(); return; }
        if (running) return; running = true;
        try { const data = await api('/api/update/check?force=1', { timeoutMs: 4000 }); if (data.managed && (!data.hasUpdate || String(data.running) === String(update.latest))) location.reload(); } catch {} finally { running = false; }
      }, 2500);
    } catch (error) { setBusy(false); toast(error, 'error'); }
  }
  if (!update) return null;
  return <>
    {!open && <div className="update-banner"><Download size={16} /><span>新版本 v{update.latest}</span><Button variant="ghost" size="sm" onClick={() => setOpen(true)}>查看 <ArrowUpRight size={14} /></Button><Button variant="ghost" size="icon" aria-label="关闭更新提示" onClick={() => { setUpdate(null); current.current = null; }}><X size={15} /></Button></div>}
    <Modal open={open} onClose={later} closeable={!update.force && !busy} title={waiting ? '正在更新并重启' : `发现新版本 v${update.latest}`} description={waiting ? '服务恢复后会自动刷新页面，请稍候。' : '查看本次更新内容，选择适合的时间更新。'} footer={!waiting && <>{!update.force && <Button variant="secondary" disabled={busy} onClick={later}>稍后</Button>}<Button loading={busy} onClick={apply}>更新并重启</Button></>}>
      {update.force && !waiting && <Badge tone="warning">此版本需要更新</Badge>}<div className="update-notes">{waiting ? '通常需要 10–20 秒，最长等待 90 秒。' : update.notes || '此次没有提供更新日志。'}</div>
    </Modal>
  </>;
}
