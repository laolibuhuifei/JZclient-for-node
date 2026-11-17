import React, { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import './md-select.css';
import { layoutRect, layoutViewport } from '../lib/displayScale';

type Option = { value: string; label: React.ReactNode; text: string; disabled: boolean; group?: string };
type Props = React.SelectHTMLAttributes<HTMLSelectElement>;
function textOf(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return textOf(node.props.children);
  return React.Children.toArray(node).map(textOf).join('');
}
function optionsOf(children: React.ReactNode, group?: string, disabled = false): Option[] {
  return React.Children.toArray(children).flatMap(child => {
    if (!React.isValidElement<any>(child)) return [];
    const option = child.props as { value?: string | number; children?: React.ReactNode; label?: string; disabled?: boolean };
    if (child.type === 'option') return [{ value: String(option.value ?? textOf(option.children)), label: option.children, text: textOf(option.children), disabled: disabled || !!option.disabled, group }];
    return optionsOf(option.children, child.type === 'optgroup' ? option.label : group, disabled || !!option.disabled);
  });
}

/** A themed select-only combobox, retaining a native value for form submission. */
const MDSelect = forwardRef<HTMLSelectElement, Props>(function MDSelect({ children, value, defaultValue, className = '', onChange, onInvalid, disabled, id, ...props }, forwardedRef) {
  const options = optionsOf(children);
  const [internal, setInternal] = useState(() => String(defaultValue ?? options.find(option => !option.disabled)?.value ?? ''));
  const selected = String(value ?? internal);
  const selectedOption = options.find(option => option.value === selected);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(selected);
  const [labelId, setLabelId] = useState<string>();
  const uid = useId();
  const panelId = `${uid}-options`;
  const optionId = (optionValue: string) => `${uid}-option-${options.findIndex(option => option.value === optionValue)}`;
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ value: '', at: 0 });
  const current = useRef({ options, selected, disabled, active });
  current.current = { options, selected, disabled, active };

  const setNative = useCallback((node: HTMLSelectElement | null) => {
    native.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);
  useLayoutEffect(() => {
    const label = trigger.current?.closest('label');
    const title = label?.querySelector<HTMLElement>('.field-label');
    if (title) { if (!title.id) title.id = `${uid}-label`; setLabelId(title.id); }
  }, [uid]);

  const position = useCallback(() => {
    if (!trigger.current || !panel.current) return;
    const rect = layoutRect(trigger.current);
    const viewport = layoutViewport();
    const margin = 12;
    const availableBelow = viewport.height - rect.bottom - margin;
    const availableAbove = rect.top - margin;
    const upward = availableBelow < Math.min(240, options.length * 48 + 16) && availableAbove > availableBelow;
    const available = Math.max(48, (upward ? availableAbove : availableBelow) - 6);
    const width = Math.min(Math.max(rect.width, 160), viewport.width - margin * 2);
    Object.assign(panel.current.style, {
      width: `${width}px`, maxHeight: `${Math.min(320, available)}px`, left: `${Math.max(margin, Math.min(rect.left, viewport.width - width - margin))}px`,
      top: upward ? 'auto' : `${rect.bottom + 6}px`, bottom: upward ? `${viewport.height - rect.top + 6}px` : 'auto',
      transformOrigin: upward ? 'bottom left' : 'top left',
    });
  }, [options.length]);
  function close(restoreFocus = true) {
    panel.current?.hidePopover?.();
    setOpen(false);
    if (restoreFocus) trigger.current?.focus({ preventScroll: true });
  }
  function show() {
    if (native.current?.matches(':disabled') || disabled || !options.some(option => !option.disabled)) return;
    setActive(selectedOption && !selectedOption.disabled ? selected : options.find(option => !option.disabled)!.value);
    position();
    panel.current?.showPopover?.();
    setOpen(true);
  }
  function invalid(event: React.InvalidEvent<HTMLSelectElement>) {
    event.preventDefault();
    const form = event.currentTarget.form;
    const firstInvalid = form && Array.from(form.elements).find(element => {
      const control = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      return control.willValidate && !control.validity.valid;
    });
    // Form validation fires for every invalid field; keep focus on the first.
    if (!firstInvalid || firstInvalid === event.currentTarget) {
      show();
      trigger.current?.focus({ preventScroll: true });
    }
    onInvalid?.(event);
  }
  function choose(next: string) {
    const option = current.current.options.find(option => option.value === next && !option.disabled);
    if (!option || native.current?.matches(':disabled')) return;
    if (native.current && next !== current.current.selected) {
      native.current.value = next;
      native.current.dispatchEvent(new Event('change', { bubbles: true }));
    }
    close();
  }
  useEffect(() => {
    if (!open) return;
    if (disabled) { close(); return; }
    let frame = 0;
    const update = () => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(position); };
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    const key = (event: KeyboardEvent) => {
      if (event.target !== trigger.current && !panel.current?.contains(event.target as Node)) return;
      const enabled = current.current.options.filter(option => !option.disabled);
      const index = Math.max(0, enabled.findIndex(option => option.value === current.current.active));
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      else if (event.key === 'Tab') close(false);
      else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); choose(current.current.active); }
      else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && enabled.length) {
        event.preventDefault(); event.stopImmediatePropagation();
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
        setActive(enabled[next].value);
      } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        const now = Date.now();
        typeahead.current.value = now - typeahead.current.at < 700 ? typeahead.current.value + event.key : event.key;
        typeahead.current.at = now;
        const query = typeahead.current.value.toLocaleLowerCase();
        const ordered = [...enabled.slice(index + 1), ...enabled.slice(0, index + 1)];
        const match = ordered.find(option => option.text.toLocaleLowerCase().startsWith(query));
        if (match) setActive(match.value);
      }
    };
    document.addEventListener('keydown', key, true);
    return () => { window.cancelAnimationFrame(frame); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); document.removeEventListener('keydown', key, true); };
  }, [open, disabled, position]);
  useLayoutEffect(() => {
    if (open) panel.current?.querySelector<HTMLElement>('[data-active=true]')?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);
  useEffect(() => {
    if (!open || options.some(option => option.value === active && !option.disabled)) return;
    const next = options.find(option => option.value === selected && !option.disabled) || options.find(option => !option.disabled);
    if (next) setActive(next.value); else close();
  }, [open, active, selected, options.map(option => `${option.value}:${option.disabled}`).join('|')]);

  const accessibleLabel = props['aria-label'] || (!labelId && !props['aria-labelledby'] ? trigger.current?.closest('label')?.firstChild?.textContent || props.title || '选择选项' : undefined);
  return <div className="md-select">
    <button ref={trigger} id={id} type="button" role="combobox" className={`input select md-select-trigger ${className}`} disabled={disabled}
      aria-label={accessibleLabel} aria-labelledby={props['aria-labelledby'] || labelId} aria-describedby={props['aria-describedby']} aria-invalid={props['aria-invalid']}
      aria-required={props.required || undefined} aria-haspopup="listbox" aria-expanded={open} aria-controls={panelId} aria-activedescendant={open ? optionId(active) : undefined}
      title={props.title || selectedOption?.text} onClick={() => open ? close() : show()} onKeyDown={event => {
        if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); show(); }
      }}>
      <span className="md-select-value">{selectedOption?.label ?? '选择选项'}</span><ChevronDown size={20} aria-hidden="true" />
    </button>
    <select {...props} ref={setNative} className="md-select-native" value={selected} disabled={disabled} tabIndex={-1} aria-hidden="true"
      onChange={event => { setInternal(event.target.value); onChange?.(event); }} onInvalid={invalid}>{children}</select>
    {typeof document !== 'undefined' && createPortal(<div ref={panel} id={panelId} popover="auto" role="listbox" className="md-select-menu" aria-label={accessibleLabel || trigger.current?.closest('label')?.querySelector('.field-label')?.textContent || '选项'}
      onToggle={event => setOpen((event.nativeEvent as ToggleEvent).newState === 'open')}>
      {options.map((option, index) => <React.Fragment key={`${option.value}/${index}`}>
        {option.group && option.group !== options[index - 1]?.group && <div className="md-select-group" role="presentation">{option.group}</div>}
        <div id={optionId(option.value)} role="option" aria-selected={option.value === selected} aria-disabled={option.disabled || undefined} data-active={option.value === active} className="md-select-option"
          onPointerDown={event => event.preventDefault()} onPointerMove={() => { if (!option.disabled) setActive(option.value); }} onClick={() => choose(option.value)}>
          <span>{option.label}</span>{option.value === selected && <Check size={19} aria-hidden="true" />}
        </div>
      </React.Fragment>)}
    </div>, document.body)}
  </div>;
});
export default MDSelect;
