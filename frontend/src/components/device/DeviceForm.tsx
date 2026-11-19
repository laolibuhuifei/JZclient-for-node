import React, { useId, useState } from 'react';
import { Button, Field, Input, Modal, Select, Textarea, toast } from '../ui';
import TimePicker from '../TimePicker';

export type DeviceField = {
  name: string;
  label: string;
  type?: 'text' | 'number' | 'password' | 'time' | 'date' | 'textarea' | 'select' | 'weekdays';
  value?: any;
  placeholder?: string;
  required?: boolean;
  requiredRepeat?: boolean;
  min?: number | string;
  max?: number | string;
  step?: number | string;
  hint?: string;
  options?: { value: any; label: string }[];
};

type Props = {
  title: string;
  description?: string;
  fields: DeviceField[];
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => any;
};

const weekdayNames = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function formatWeekdays(mask: unknown) {
  const number = Number(mask);
  if (number === 0) return '不重复（仅一次）';
  if (number === 127) return '每天';
  if (number === 31) return '周一至周五';
  if (number === 96) return '周末';
  return weekdayNames.filter((_, index) => number & (1 << index)).join('、') || '未设置重复';
}

export function DataRows({ items }: { items: { label: React.ReactNode; value: any }[] }) {
  return <dl className="device-data-rows">{items.map((item, index) => <div key={index}>
    <dt>{item.label}</dt><dd>{item.value == null || item.value === '' ? '—' : typeof item.value === 'boolean' ? item.value ? '是' : '否' : typeof item.value === 'object' && !React.isValidElement(item.value) ? JSON.stringify(item.value) : item.value}</dd>
  </div>)}</dl>;
}

export default function DeviceForm({ title, description, fields, submitLabel = '保存', onClose, onSubmit }: Props) {
  const formId = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map(field => [field.name,
    String(field.value ?? (field.type === 'select' ? field.options?.[0]?.value ?? '' : field.type === 'weekdays' ? 127 : ''))])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const change = (name: string, value: string) => setValues(current => ({ ...current, [name]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const emptyWeek = fields.find(field => field.type === 'weekdays' && field.requiredRepeat && !Number(values[field.name]));
    if (emptyWeek) { setError(`请为“${emptyWeek.label}”选择至少一天`); return; }
    setBusy(true);
    setError('');
    try {
      await onSubmit(values);
      toast('已保存', 'success');
      onClose();
    } catch (cause: any) {
      setError(cause?.message || '保存失败，请重试');
    } finally { setBusy(false); }
  };
  return <Modal open className="device-form-modal" onClose={() => { if (!busy) onClose(); }} title={title} description={description} size="md" closeable={!busy} footer={<>
    <Button variant="secondary" disabled={busy} onClick={onClose}>取消</Button>
    <Button type="submit" form={formId} loading={busy}>{busy ? '保存中…' : submitLabel}</Button>
  </>}>
    <form id={formId} className="device-editor-form" onSubmit={submit}>
      {fields.map(field => field.type === 'weekdays' ? <fieldset key={field.name} className="field device-weekday-field device-full-width">
        <legend className="field-label">{field.label}</legend>
        <div className="device-weekdays">
          {weekdayNames.map((day, index) => <label key={day} className={(Number(values[field.name]) & (1 << index)) ? 'is-selected' : ''}>
            <input type="checkbox" checked={!!(Number(values[field.name]) & (1 << index))} disabled={busy} onChange={event => change(field.name, String(event.target.checked ? Number(values[field.name]) | (1 << index) : Number(values[field.name]) & ~(1 << index)))} />{day}
          </label>)}
        </div>
        <span className="field-hint" aria-live="polite">{formatWeekdays(values[field.name])}</span>
        {field.hint && <span className="field-hint">{field.hint}</span>}
      </fieldset> : <Field key={field.name} className={field.type === 'textarea' ? 'device-full-width' : undefined} label={field.label} hint={field.hint}>
        {field.type === 'textarea' ? <Textarea name={field.name} value={values[field.name]} placeholder={field.placeholder} required={field.required} disabled={busy} onChange={event => change(field.name, event.target.value)} rows={4} />
          : field.type === 'select' ? <Select name={field.name} value={values[field.name]} required={field.required} disabled={busy} onChange={event => change(field.name, event.target.value)}>
            {(field.options || []).map(option => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
          </Select>
          : field.type === 'time' ? <TimePicker name={field.name} label={field.label} value={values[field.name]} required={field.required} min={field.min} max={field.max} step={field.step} disabled={busy} onChange={value => change(field.name, value)} />
          : <Input name={field.name} type={field.type || 'text'} value={values[field.name]} placeholder={field.placeholder} required={field.required} min={field.min} max={field.max} step={field.step} disabled={busy} onChange={event => change(field.name, event.target.value)} />}
      </Field>)}
      {error && <p className="device-form-error device-full-width" role="alert">{error}</p>}
    </form>
  </Modal>;
}
