import React, { useEffect, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, toast } from '../ui';

const ROLE_TEXT: Record<string, string> = { 0: '管理员', 1: '成员', 2: '成员', 3: '联系人', 4: '联系人', 6: '校讯通' };
const displayName = (contact: any) => String(contact.salutation || contact.remarkName || '未命名联系人');
type ContactValues = { salutation: string; mobileNumber: string; shortNumber: string };

export default function ContactsPanel({ watchId }: { watchId: string; caps?: any }) {
  const base = `/api/watch/${encodeURIComponent(watchId)}/contacts`;
  const { data, loading, error, reload } = useResource(() => api(base), [watchId]);
  const contacts: any[] = Array.isArray(data?.contacts) ? data.contacts : [];
  const [editor, setEditor] = useState<{ contact: any | null } | null>(null);
  const [values, setValues] = useState<ContactValues>({ salutation: '', mobileNumber: '', shortNumber: '' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [deleting, setDeleting] = useState<any>(null);
  const [deletePending, setDeletePending] = useState(false);
  useEffect(() => { setEditor(null); setDeleting(null); setSaveError(''); }, [watchId]);

  const openEditor = (contact: any | null) => {
    setValues({
      salutation: contact ? String(contact.salutation || contact.remarkName || '') : '',
      mobileNumber: contact ? String(contact.mobileNumberNew || contact.mobileNumber || '') : '',
      shortNumber: contact ? String(contact.shortNumber || '') : '',
    });
    setSaveError('');
    setEditor({ contact });
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!editor || saving) return;
    const payload = { salutation: values.salutation.trim(), mobileNumber: values.mobileNumber.trim(), shortNumber: values.shortNumber.trim() };
    if (!editor.contact && (!payload.salutation || !payload.mobileNumber)) { setSaveError('请填写称呼和号码。'); return; }
    setSaving(true);
    setSaveError('');
    try {
      if (editor.contact) {
        await api(`${base}/${encodeURIComponent(String(editor.contact.id))}`, { method: 'PUT', body: payload });
      } else {
        await post(base, payload);
      }
      toast(editor.contact ? '联系人已保存' : '联系人已添加', 'success');
      setEditor(null);
      reload();
    } catch (failure: any) {
      const message = failure?.message || '保存联系人失败';
      setSaveError(message);
      toast(message, 'danger');
    } finally { setSaving(false); }
  };
  const remove = async () => {
    if (!deleting || deletePending) return;
    setDeletePending(true);
    try {
      await api(`${base}/${encodeURIComponent(String(deleting.id))}`, { method: 'DELETE' });
      setDeleting(null);
      toast('联系人已删除', 'success');
      reload();
    } catch (failure: any) {
      toast(failure?.message || '删除联系人失败', 'danger');
    } finally { setDeletePending(false); }
  };

  return <div className="device-contacts-page stack">
    <PageHeader title="通讯录" description="管理手表的家庭成员与常用联系人。" actions={<>
      <Button variant="secondary" onClick={reload} disabled={loading} aria-label="刷新通讯录"><RefreshCw size={16} />刷新</Button>
      <Button onClick={() => openEditor(null)}><Plus size={16} />添加联系人</Button>
    </>} />
    <Card className="device-contacts-card" title="联系人" action={<Badge>{contacts.length} 人</Badge>}>
      {loading && !data ? <LoadingState /> : error ? <ErrorState error={error} onRetry={reload} /> : !contacts.length ? <EmptyState title="通讯录为空" description="添加称呼和电话号码，让宝贝可以从手表联系家人。" action={<Button onClick={() => openEditor(null)}><Plus size={16} />添加联系人</Button>} /> : <div role="list">
        {contacts.map((contact, index) => <div role="listitem" className="device-item device-person-item" key={contact.id ?? index}>
          <span className="device-icon device-person-avatar" aria-hidden="true">{displayName(contact).slice(0, 1)}</span>
          <div className="device-item-main">
            <div className="device-item-name-row"><strong className="device-item-title">{displayName(contact)}</strong><Badge>{ROLE_TEXT[String(contact.type)] || `类型 ${contact.type ?? '未知'}`}</Badge></div>
            <p className="device-item-description">{contact.mobileNumber || '未提供号码'}{contact.shortNumber ? ` · 短号 ${contact.shortNumber}` : ''}</p>
          </div>
          <div className="action-row device-item-actions">
            <Button variant="ghost" disabled={contact.id == null} onClick={() => openEditor(contact)} aria-label={`编辑联系人 ${displayName(contact)}`}><Pencil size={18} /><span className="device-item-action-label">编辑</span></Button>
            <Button variant="ghost" disabled={contact.id == null} onClick={() => setDeleting(contact)} aria-label={`删除联系人 ${displayName(contact)}`}><Trash2 size={18} /><span className="device-item-action-label">删除</span></Button>
          </div>
        </div>)}
      </div>}
    </Card>
    <Modal open={!!editor} closeable={!saving} className="device-form-modal" onClose={() => { if (!saving) setEditor(null); }} title={editor?.contact ? '编辑联系人' : '添加联系人'} description="联系人将同步到当前手表的通讯录。" footer={<>
      <Button variant="secondary" disabled={saving} onClick={() => setEditor(null)}>取消</Button><Button type="submit" form="device-contact-form" disabled={saving}>{saving ? '正在保存…' : editor?.contact ? '保存联系人' : '添加联系人'}</Button>
    </>}>
      <form id="device-contact-form" onSubmit={save} className="stack">
        <Field label="称呼"><Input name="salutation" autoFocus required={!editor?.contact} disabled={saving} value={values.salutation} onChange={e => setValues(current => ({ ...current, salutation: e.target.value }))} placeholder="例如：爸爸" /></Field>
        <Field label="号码"><Input name="mobileNumber" type="tel" required={!editor?.contact} disabled={saving} value={values.mobileNumber} onChange={e => setValues(current => ({ ...current, mobileNumber: e.target.value }))} placeholder="请输入电话号码" /></Field>
        <Field label="短号" hint="可选；家庭网或集团网短号。"><Input name="shortNumber" type="tel" disabled={saving} value={values.shortNumber} onChange={e => setValues(current => ({ ...current, shortNumber: e.target.value }))} /></Field>
        {saveError && <p role="alert" className="device-form-error">{saveError}</p>}
      </form>
    </Modal>
    <Modal open={!!deleting} closeable={!deletePending} onClose={() => { if (!deletePending) setDeleting(null); }} title="删除联系人" description={`确认将“${deleting ? displayName(deleting) : ''}”从当前手表的通讯录删除？`} footer={<>
      <Button variant="secondary" disabled={deletePending} onClick={() => setDeleting(null)}>取消</Button><Button variant="danger" disabled={deletePending} onClick={remove}>{deletePending ? '正在删除…' : '确认删除'}</Button>
    </>}><p className="muted">请确认该联系人不再需要保留。</p></Modal>
  </div>;
}
