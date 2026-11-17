import React, { forwardRef, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertCircle, Check, CheckCircle2, Inbox, Loader2, X } from 'lucide-react';
import { useSlidingIndicator } from './useSlidingIndicator';
import { useOptionalApp } from '../context/AppContext';
import DeviceWatchPicker from './DeviceWatchPicker';

export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md' | 'lg' | 'icon'; loading?: boolean;
}>(({ variant = 'primary', size = 'md', loading, className = '', children, disabled, ...props }, ref) =>
  <button type="button" {...props} ref={ref} disabled={disabled || loading} aria-busy={loading || props['aria-busy']} className={`button button-${variant} button-${size} ${className}`}>
    {loading && <Loader2 size={16} className="spin" aria-hidden="true" />}{children}
  </button>);

export function Card({ title, description, action, className = '', children, ...props }: Omit<React.HTMLAttributes<HTMLElement>, 'title'> & { title?: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }) {
  return <section {...props} className={`card ${className}`}>
    {(title || description || action) && <div className="card-head"><div>{title && <h2>{title}</h2>}{description && <p className="muted">{description}</p>}</div>{action}</div>}{children}
  </section>;
}

export function Badge({ tone = 'neutral', children, className = '', ...props }: React.HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'info' }) {
  return <span {...props} className={`badge badge-${tone} ${className}`}>{children}</span>;
}
export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className = '', ...props }, ref) => <input {...props} ref={ref} className={`input ${className}`} />);
export { default as Select } from './MDSelect';
export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className = '', ...props }, ref) => <textarea rows={4} {...props} ref={ref} className={`input textarea ${className}`} />);
export function Field({ label, hint, children, className = '' }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}
export function PageHeader({ title, description, actions, titleAccessory }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; titleAccessory?: React.ReactNode }) {
  const app = useOptionalApp();
  const devicePicker = app && !['home', 'account', 'announcements', 'logs', 'plugins', 'plugin', 'bind'].includes(app.page);
  return <div className={`page-header${devicePicker ? ' page-header-with-watch' : ''}`}><div className="page-heading-content"><div className="page-heading-row"><div className="page-title-group"><h1>{title}</h1>{titleAccessory}</div>{devicePicker && <DeviceWatchPicker />}</div>{devicePicker ? <div className="page-header-detail-row">{description && <p>{description}</p>}{actions && <div className="action-row page-header-actions">{actions}</div>}</div> : description && <p>{description}</p>}</div>{!devicePicker && actions && <div className="action-row page-header-actions">{actions}</div>}</div>;
}
export function EmptyState({ title, description, action, icon }: { title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode; icon?: React.ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon || <Inbox size={25} />}</div><h3>{title}</h3>{description && <p>{description}</p>}{action && <div className="action-row">{action}</div>}</div>;
}
export function LoadingState({ text = '正在加载…', label }: { text?: string; label?: string }) {
  return <div className="loading-state" role="status"><Loader2 className="spin" size={20} /><span>{label || text}</span></div>;
}
export function Skeleton({ className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) { return <div {...props} className={`skeleton ${className}`} />; }
export function ErrorState({ error, onRetry }: { error: any; onRetry?: () => any }) {
  return <div className="error-state" role="alert"><AlertCircle size={21} /><div><strong>暂时无法加载</strong><p>{error?.message || String(error || '请稍后重试')}</p></div>{onRetry && <Button variant="secondary" onClick={() => onRetry()}>重试</Button>}</div>;
}

export function Modal({ open, onClose, title, description, children, footer, size = 'md', closeable = true, className = '' }: {
  open: boolean; onClose: () => void; title: React.ReactNode; description?: React.ReactNode; children?: React.ReactNode; footer?: React.ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; closeable?: boolean; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  const closeableRef = useRef(closeable); closeableRef.current = closeable;
  const titleId = useId(); const descriptionId = useId();
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    const target = Array.from(ref.current?.querySelectorAll<HTMLElement>('input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),button:not(:disabled)') || []).find(el => el.getAttribute('aria-hidden') !== 'true' && el.tabIndex !== -1 && !el.hidden && window.getComputedStyle(el).display !== 'none');
    (target || ref.current)?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (!ref.current) return;
      const dialogs = document.querySelectorAll<HTMLDivElement>('.modal-card[aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== ref.current) return;
      // The browser owns Escape while a map inside this modal is fullscreen.
      if (document.fullscreenElement && ref.current.contains(document.fullscreenElement)) return;
      if (event.key === 'Escape' && closeableRef.current) { event.preventDefault(); event.stopImmediatePropagation(); onCloseRef.current(); }
      if (event.key === 'Tab') {
        const list = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href],button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(el => el.getClientRects().length && el.getAttribute('aria-hidden') !== 'true' && el.tabIndex !== -1 && !el.hidden);
        const first = list[0]; const last = list[list.length - 1];
        if (!first) { event.preventDefault(); ref.current.focus(); }
        else if (!ref.current.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus({ preventScroll: true }); }
        else if (event.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', onKey); previous?.focus?.({ preventScroll: true }); };
  }, [open]);
  if (!open) return null;
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (closeable && event.target === event.currentTarget) { event.preventDefault(); onClose(); } }}>
    <div className={`modal-card modal-${size} ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} ref={ref}>
      <div className="modal-head"><div><h2 id={titleId}>{title}</h2>{description && <p id={descriptionId}>{description}</p>}</div>{closeable && <Button variant="ghost" size="icon" aria-label="关闭弹窗" onClick={onClose}><X size={19} /></Button>}</div>
      <div className="modal-body">{children}</div>{footer && <div className="modal-footer">{footer}</div>}
    </div>
  </div>, document.body);
}
export function Tabs({ items, value, onChange, label = '选项' }: { items: { value: string; label: React.ReactNode; disabled?: boolean }[]; value: string; onChange: (value: string) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.filter(item => !item.disabled);
  const active = enabled.some(item => item.value === value) ? value : enabled[0]?.value;
  const indicator = useSlidingIndicator(ref, active, 'tabs', items.map(item => `${item.value}:${!!item.disabled}`).join('|'));
  function keyboard(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !enabled.length) return;
    const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[role="tab"]');
    if (!target) return;
    event.preventDefault();
    const index = Math.max(0, enabled.findIndex(item => item.value === target.dataset.tabValue));
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
    const nextValue = enabled[next].value;
    onChange(nextValue);
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button[role="tab"]') || []).find(button => button.dataset.tabValue === nextValue)?.focus({ preventScroll: true });
  }
  return <div ref={ref} className="tabs" role="tablist" aria-label={label} onKeyDown={keyboard}><span className="selection-indicator" ref={indicator} aria-hidden="true" />{items.map(item => <button type="button" role="tab" data-tab-value={item.value} aria-selected={active === item.value} tabIndex={active === item.value ? 0 : -1} className={active === item.value ? 'active' : ''} key={item.value} disabled={item.disabled} onClick={() => onChange(item.value)}>{item.label}</button>)}</div>;
}
export function Toggle({ checked, onChange, label, disabled, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange' | 'type'> & { checked: boolean; onChange: (value: boolean) => void; label?: React.ReactNode }) {
  const labelId = useId();
  return <label className={`toggle-label ${disabled ? 'disabled' : ''}`}><input {...props} type="checkbox" role="switch" checked={!!checked} disabled={disabled} onChange={event => onChange(event.target.checked)} aria-labelledby={props['aria-labelledby'] || (label ? labelId : undefined)} aria-label={props['aria-label'] || (label ? undefined : '开关')} /><span className="toggle-track" aria-hidden="true"><span><Check size={16} /></span></span>{label && <span id={labelId}>{label}</span>}</label>;
}

type ToastMessage = { id: number; message: string; tone: string };
let nextToast = 0;
export function toast(message: any, tone: string | boolean = 'success') {
  window.dispatchEvent(new CustomEvent('jz:toast', { detail: { id: ++nextToast, message: message?.message || String(message), tone: tone === true ? 'error' : tone } }));
}
export function ToastHost() {
  const [messages, setMessages] = useState<ToastMessage[]>([]);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const show = (event: Event) => { const item = (event as CustomEvent).detail; setMessages(previous => [...previous.slice(-3), item]); const timer = setTimeout(() => { setMessages(previous => previous.filter(message => message.id !== item.id)); timers.delete(timer); }, 4200); timers.add(timer); };
    window.addEventListener('jz:toast', show);
    return () => { window.removeEventListener('jz:toast', show); timers.forEach(clearTimeout); };
  }, []);
  return <div className="toast-host" aria-live="polite">{messages.map(item => <div className={`toast toast-${item.tone}`} key={item.id}>{item.tone === 'error' || item.tone === 'danger' ? <AlertCircle size={19} /> : <CheckCircle2 size={19} />}<span>{item.message}</span><button type="button" aria-label="关闭提示" onClick={() => setMessages(previous => previous.filter(message => message.id !== item.id))}><X size={15} /></button></div>)}</div>;
}
