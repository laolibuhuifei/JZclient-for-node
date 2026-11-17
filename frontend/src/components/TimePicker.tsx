import React, { useEffect, useId, useRef, useState } from 'react';
import { Clock3, Keyboard } from 'lucide-react';
import { Button, Input, Modal } from './ui';
import './time-picker.css';

const pad = (value: number) => String(value).padStart(2, '0');
type TimeParts = [number, number];
type ClockStage = 'hour' | 'minute';
const wheelRowHeight = 44;
const mobileQuery = '(max-width: 767px), (pointer: coarse)';

export function parseTimeValue(value: string): TimeParts | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  return match && +match[1] < 24 && +match[2] < 60 ? [+match[1], +match[2]] : null;
}

// Angles start at twelve o'clock; the inner hour ring contains 00 and 13–23.
export function clockValueAtPoint(stage: ClockStage, x: number, y: number, size: number): number | null {
  if (!Number.isFinite(size) || size <= 0) return null;
  const dx = x - size / 2, dy = y - size / 2;
  const distance = Math.hypot(dx, dy);
  if (distance < size * 0.06) return null;
  const angle = (Math.atan2(dx, -dy) + Math.PI * 2) % (Math.PI * 2);
  if (stage === 'minute') return Math.round(angle / (Math.PI * 2) * 60) % 60;
  const hour = Math.round(angle / (Math.PI * 2) * 12) % 12;
  return distance < size * 0.33 ? hour === 0 ? 0 : hour + 12 : hour === 0 ? 12 : hour;
}

export function validateTimeValue(value: string, constraints: { required?: boolean; min?: number | string; max?: number | string; step?: number | string } = {}) {
  if (!value) return constraints.required ? '请选择时间后再确定。' : '';
  if (!parseTimeValue(value)) return '小时应为 00–23，分钟应为 00–59。';
  // Use the same time constraint algorithm as the form control, including ranges across midnight.
  const validation = document.createElement('input');
  validation.type = 'time';
  validation.value = value;
  validation.required = !!constraints.required;
  if (constraints.min != null) validation.min = String(constraints.min);
  if (constraints.max != null) validation.max = String(constraints.max);
  if (constraints.step != null) validation.step = String(constraints.step);
  if (validation.validity.rangeUnderflow || validation.validity.rangeOverflow) return '这个时间不在允许范围内，请重新选择。';
  if (validation.validity.stepMismatch) return '这个时间不符合设置的时间间隔，请调整后重试。';
  return validation.validity.valid ? '' : '请选择有效的时间后再确定。';
}

function TimeWheel({ label, count, value, onChange }: { label: string; count: number; value: number; onChange: (value: number) => void }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selecting = useRef(false);
  const userScrolling = useRef(false);
  useEffect(() => {
    const wheel = ref.current;
    if (wheel && Math.abs(wheel.scrollTop - value * wheelRowHeight) > 1 && !selecting.current) {
      userScrolling.current = false;
      wheel.scrollTop = value * wheelRowHeight;
    }
  }, [value]);
  useEffect(() => () => { if (pending.current) clearTimeout(pending.current); }, []);
  const choose = (next: number) => {
    if (pending.current) clearTimeout(pending.current);
    selecting.current = false;
    userScrolling.current = false;
    onChange(next);
    if (ref.current) ref.current.scrollTop = next * wheelRowHeight;
  };
  return <div className="time-wheel-column"><span className="time-wheel-label">{label}</span><div className="time-wheel" ref={ref} role="listbox" aria-label={label} tabIndex={0} aria-activedescendant={`${id}-${value}`} onPointerDown={() => { userScrolling.current = true; }} onWheel={() => { userScrolling.current = true; }} onKeyDown={event => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === 'PageDown' ? 5 : event.key === 'PageUp' ? -5 : event.key === 'ArrowDown' ? 1 : -1;
    choose(event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : Math.max(0, Math.min(count - 1, value + delta)));
  }} onScroll={() => {
    // Position restoration must not turn an empty field into an implicitly chosen 00:00.
    if (!userScrolling.current) return;
    selecting.current = true;
    const current = Math.max(0, Math.min(count - 1, Math.round((ref.current?.scrollTop || 0) / wheelRowHeight)));
    onChange(current);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      const next = Math.max(0, Math.min(count - 1, Math.round((ref.current?.scrollTop || 0) / wheelRowHeight)));
      selecting.current = false;
      onChange(next);
    }, 90);
  }}>{Array.from({ length: count }, (_, index) => <div id={`${id}-${index}`} role="option" aria-selected={value === index} className={`time-wheel-option ${value === index ? 'is-selected' : ''}`} key={index} onClick={() => choose(index)}>{pad(index)}</div>)}</div></div>;
}

function ClockDial({ stage, value, selected, onChange, onAdvance }: { stage: ClockStage; value: number; selected: boolean; onChange: (value: number) => void; onAdvance: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const drag = useRef<{ pointer: number; changed: boolean } | null>(null);
  const count = stage === 'hour' ? 24 : 60;
  const radius = stage === 'hour' && (value === 0 || value > 12) ? 74 : 112;
  const angle = (stage === 'hour' ? value % 12 / 12 : value / 60) * Math.PI * 2;
  const tip = { x: 140 + Math.sin(angle) * radius, y: 140 - Math.cos(angle) * radius };
  const numbers = stage === 'hour' ? [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
    : Array.from({ length: 12 }, (_, index) => index * 5).filter(number => !selected || value % 5 === 0 || Math.min(Math.abs(number - value), 60 - Math.abs(number - value)) >= 3).concat(selected && value % 5 ? [value] : []);

  function point(event: React.PointerEvent, useLabel = false) {
    if (useLabel) {
      const number = (event.target as HTMLElement).closest<HTMLElement>('[data-time-value]')?.dataset.timeValue;
      if (number != null) return Number(number);
    }
    const rect = ref.current?.getBoundingClientRect();
    return rect ? clockValueAtPoint(stage, event.clientX - rect.left, event.clientY - rect.top, rect.width) : null;
  }
  function release(event: React.PointerEvent, advance: boolean) {
    const active = drag.current;
    if (!active || event.pointerId !== active.pointer) return;
    drag.current = null;
    if (ref.current?.hasPointerCapture?.(event.pointerId)) ref.current.releasePointerCapture(event.pointerId);
    if (advance && active.changed && stage === 'hour') onAdvance();
  }
  return <div className="time-dial-layout">
    <div ref={ref} className={`time-clock-dial time-clock-${stage}`} data-time-stage={stage} role="slider" aria-label={stage === 'hour' ? '小时转盘' : '分钟转盘'} aria-valuemin={0} aria-valuemax={count - 1} aria-valuenow={value} aria-valuetext={selected ? `${pad(value)} ${stage === 'hour' ? '时' : '分'}` : `尚未选择${stage === 'hour' ? '小时' : '分钟'}`} aria-describedby={hintId} tabIndex={0}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.stopPropagation();
        ref.current?.focus({ preventScroll: true });
        const next = point(event, true);
        drag.current = { pointer: event.pointerId, changed: next != null };
        ref.current?.setPointerCapture?.(event.pointerId);
        if (next != null) onChange(next);
      }} onPointerMove={event => {
        if (!drag.current || event.pointerId !== drag.current.pointer) return;
        const next = point(event);
        if (next != null) { drag.current.changed = true; onChange(next); }
      }} onPointerUp={event => release(event, true)} onPointerCancel={event => release(event, false)} onLostPointerCapture={() => { drag.current = null; }}
      onClick={event => {
        // A synthesized accessibility click has no preceding pointer gesture.
        if (event.detail !== 0) return;
        const number = (event.target as HTMLElement).closest<HTMLElement>('[data-time-value]')?.dataset.timeValue;
        if (number == null) return;
        event.preventDefault(); event.stopPropagation(); onChange(Number(number));
        if (stage === 'hour') onAdvance();
      }} onKeyDown={event => {
        if (['Enter', ' '].includes(event.key)) {
          event.preventDefault(); event.stopPropagation(); onChange(value);
          if (stage === 'hour') onAdvance();
          return;
        }
        if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const step = stage === 'hour' ? 3 : 5;
        const delta = event.key === 'PageUp' ? step : event.key === 'PageDown' ? -step : ['ArrowUp', 'ArrowRight'].includes(event.key) ? 1 : -1;
        onChange(event.key === 'Home' ? 0 : event.key === 'End' ? count - 1 : (value + delta + count) % count);
      }}>
      <svg className="time-clock-hand" viewBox="0 0 280 280" aria-hidden="true">
        {selected && <><line x1="140" y1="140" x2={tip.x} y2={tip.y} /><circle cx={tip.x} cy={tip.y} r={radius === 74 ? 17 : 21} /></>}
        <circle cx="140" cy="140" r="3" />
      </svg>
      {numbers.map(number => {
        const inner = stage === 'hour' && (number === 0 || number > 12);
        const r = inner ? 74 : 112;
        const a = (stage === 'hour' ? number % 12 / 12 : number / 60) * Math.PI * 2;
        return <span key={number} aria-hidden="true" data-time-value={number} className={`time-clock-number${inner ? ' is-inner' : ''}${selected && number === value ? ' is-selected' : ''}`} style={{ left: `${50 + Math.sin(a) * r / 280 * 100}%`, top: `${50 - Math.cos(a) * r / 280 * 100}%` }}>{stage === 'minute' || inner ? pad(number) : number}</span>;
      })}
    </div>
    <p id={hintId} className="time-dial-hint">{stage === 'hour' ? '内圈为 00、13–23 时。可点击或拖动指针。' : '点击或拖动选择分钟，方向键可逐分钟调整。'}</p>
  </div>;
}

export default function TimePicker({ value, onChange, label, ...props }: Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & { value: string; onChange: (value: string) => void; label: string }) {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(mobileQuery).matches);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<TimeParts>([0, 0]);
  const draftRef = useRef<TimeParts>([0, 0]);
  const [selected, setSelected] = useState(false);
  const [stage, setStage] = useState<ClockStage>('hour');
  const [mode, setMode] = useState<'dial' | 'keyboard'>('dial');
  const [typed, setTyped] = useState<[string, string]>(['', '']);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(mobileQuery);
    const update = () => { setMobile(query.matches); setOpen(false); };
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  useEffect(() => { if (props.disabled || props.readOnly) setOpen(false); }, [props.disabled, props.readOnly]);
  function show(message = '') {
    if (props.disabled || props.readOnly) return;
    const initial = parseTimeValue(value);
    draftRef.current = initial || [0, 0];
    setDraft(draftRef.current); setTyped(initial ? [pad(initial[0]), pad(initial[1])] : ['', '']);
    setSelected(!!initial); setStage('hour'); setMode('dial'); setError(message); setOpen(true);
  }
  function choose(index: 0 | 1, next: number) {
    const result: TimeParts = index === 0 ? [next, draftRef.current[1]] : [draftRef.current[0], next];
    draftRef.current = result; setDraft(result); setTyped([pad(result[0]), pad(result[1])]); setSelected(true); setError('');
  }
  function typedValue(): string | null {
    if (!typed[0] && !typed[1]) return '';
    if (!/^\d{1,2}$/.test(typed[0]) || !/^\d{1,2}$/.test(typed[1]) || +typed[0] > 23 || +typed[1] > 59) return null;
    return `${pad(+typed[0])}:${pad(+typed[1])}`;
  }
  function clear() {
    draftRef.current = [0, 0]; setDraft([0, 0]); setTyped(['', '']); setSelected(false); setError('');
  }
  function confirm() {
    const next = !mobile && mode === 'keyboard' ? typedValue() : selected ? `${pad(draftRef.current[0])}:${pad(draftRef.current[1])}` : '';
    if (next == null) { setError('小时应为 00–23，分钟应为 00–59，请补全时间。'); return; }
    const message = validateTimeValue(next, props);
    if (message) { setError(message); return; }
    if (next !== value) onChange(next);
    setOpen(false);
  }
  function switchMode() {
    if (mode === 'keyboard') {
      const next = typedValue();
      if (next == null) { setError('请补全有效时间，或清空后切换到转盘。'); return; }
      if (next) { draftRef.current = parseTimeValue(next)!; setDraft(draftRef.current); setTyped([pad(draftRef.current[0]), pad(draftRef.current[1])]); setSelected(true); }
      else clear();
    }
    setError(''); setMode(mode === 'dial' ? 'keyboard' : 'dial');
  }
  return <div className="md-time-picker" data-mobile={mobile}>
    <Input {...props} ref={input} type="time" value={parseTimeValue(value) ? value : ''} onChange={() => {}} hidden aria-label={label} className="time-canonical-input" tabIndex={-1} aria-hidden="true" onInvalid={event => {
      event.preventDefault();
      const element = event.currentTarget;
      const firstInvalid = element.form && Array.from(element.form.elements).find(control => {
        const candidate = control as HTMLInputElement;
        return candidate.willValidate && !candidate.validity.valid;
      });
      if (!firstInvalid || firstInvalid === element) show(validateTimeValue(element.value, props) || '请选择有效时间。');
      props.onInvalid?.(event);
    }} />
    <Button ref={trigger} variant="secondary" className={`time-picker-trigger ${props.className || ''}`} disabled={props.disabled || props.readOnly} onClick={() => show()} aria-label={`选择${label}${parseTimeValue(value) ? `，当前 ${value}` : ''}`} aria-describedby={props['aria-describedby']} aria-haspopup="dialog" aria-expanded={open} tabIndex={props.tabIndex}><span>{parseTimeValue(value) ? value : props.placeholder || '选择时间'}</span><Clock3 size={20} aria-hidden="true" /></Button>
    <Modal open={open} onClose={() => setOpen(false)} title={`选择${label}`} className={`time-picker-dialog ${mobile ? 'time-picker-mobile' : 'time-picker-desktop'}`} size="sm" footer={<>
      <div className="time-picker-footer-tools">{!mobile && <Button variant="ghost" size="icon" aria-label={mode === 'dial' ? '键盘输入' : '切换到时钟转盘'} title={mode === 'dial' ? '键盘输入' : '时钟转盘'} onClick={switchMode}>{mode === 'dial' ? <Keyboard size={21} aria-hidden="true" /> : <Clock3 size={21} aria-hidden="true" />}</Button>}{!props.required && <Button variant="ghost" onClick={clear}>清空</Button>}</div>
      <Button variant="secondary" onClick={() => setOpen(false)}>取消</Button><Button onClick={confirm}>确定</Button>
    </>}>
      {mobile ? <><p className="time-picker-description">上下滑动选择小时和分钟。</p><div className="time-wheel-row"><TimeWheel label="小时" count={24} value={draft[0]} onChange={hour => choose(0, hour)} /><span className="time-wheel-separator" aria-hidden="true">:</span><TimeWheel label="分钟" count={60} value={draft[1]} onChange={minute => choose(1, minute)} /></div><output className="time-picker-preview" aria-live="polite">{selected ? `${pad(draft[0])}:${pad(draft[1])}` : '尚未选择时间'}</output></>
        : mode === 'dial' ? <>
          <div className="time-dial-segments" aria-label="时间选择阶段"><div className="time-dial-segment-column"><button type="button" className={`time-dial-segment ${stage === 'hour' ? 'is-active' : ''}`} aria-label={`选择小时${selected ? `，当前 ${pad(draft[0])}` : ''}`} aria-pressed={stage === 'hour'} onClick={() => setStage('hour')}>{selected ? pad(draft[0]) : '—'}</button><span>小时</span></div><span className="time-dial-colon" aria-hidden="true">:</span><div className="time-dial-segment-column"><button type="button" className={`time-dial-segment ${stage === 'minute' ? 'is-active' : ''}`} aria-label={`选择分钟${selected ? `，当前 ${pad(draft[1])}` : ''}`} aria-pressed={stage === 'minute'} onClick={() => setStage('minute')}>{selected ? pad(draft[1]) : '—'}</button><span>分钟</span></div></div>
          <ClockDial stage={stage} value={draft[stage === 'hour' ? 0 : 1]} selected={selected} onChange={next => choose(stage === 'hour' ? 0 : 1, next)} onAdvance={() => setStage('minute')} />
        </> : <><p className="time-picker-description">输入 24 小时制时间。</p><div className="time-keyboard-fields">
          {(['小时', '分钟'] as const).map((name, index) => <label key={name}><span>{name}</span><Input type="text" inputMode="numeric" pattern="[0-9]*" maxLength={2} autoComplete="off" placeholder={index ? '00–59' : '00–23'} value={typed[index]} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined} onChange={event => {
            const next = event.target.value;
            if (!/^\d{0,2}$/.test(next)) return;
            setTyped(previous => index === 0 ? [next, previous[1]] : [previous[0], next]); setError('');
          }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); confirm(); } }} /></label>)}
        </div></>}
      {error && <p id={errorId} role="alert" className="field-error time-picker-error">{error}</p>}
    </Modal>
  </div>;
}
