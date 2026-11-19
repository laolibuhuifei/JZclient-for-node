import React, { useEffect, useId, useState } from 'react';
import { GraduationCap, Heart, RefreshCw, Save, UserRound } from 'lucide-react';
import { useApp } from '../../context/AppContext';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, PageHeader, Select, toast } from '../ui';
import './device-data-panels.css';
import WatchAvatar from '../WatchAvatar';

type ProfileValues = {
  name: string; realName: string; birthday: string; height: string;
  weight: string; gender: string; grade: string; classes: string;
};

function profileValues(account: any = {}): ProfileValues {
  let birthday = '';
  if (account.birthday) {
    const date = new Date(Number(account.birthday));
    if (!Number.isNaN(date.getTime())) {
      // The API stores birthdays at local midnight; keep the same calendar date when editing.
      birthday = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    }
  }
  const value = (field: any) => field == null ? '' : String(field);
  return {
    name: value(account.name), realName: value(account.realName), birthday,
    height: value(account.height), weight: value(account.doubleWeight),
    gender: account.gender == null ? '' : value(account.gender),
    grade: value(account.grade), classes: value(account.classes),
  };
}

export default function ProfilePanel({ watchId }: { watchId: string; caps?: any }) {
  const formId = useId();
  const { refreshWatches } = useApp();
  const base = `/api/watch/${encodeURIComponent(watchId)}/profile`;
  const { data, loading, error, reload } = useResource(() => api(base), [watchId]);
  const [values, setValues] = useState<ProfileValues>(() => profileValues());
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    setValues(profileValues(data?.account));
    setDirty(false);
  }, [data, watchId]);

  const change = (field: keyof ProfileValues, value: string) => {
    setValues(current => ({ ...current, [field]: value }));
    setDirty(true);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await post(base, values);
      setDirty(false);
      toast('宝贝资料已保存', 'success');
      // Refresh the device selector too, so a changed nickname is immediately visible.
      Promise.resolve(refreshWatches()).catch(() => {});
      reload();
    } catch (failure: any) {
      toast(failure?.message || '保存资料失败', 'danger');
    } finally {
      setSaving(false);
    }
  };

  return <div className="stack profile-page">
    <PageHeader title="宝贝资料" description="管理宝贝的姓名、生日与成长信息。" actions={
      <Button variant="secondary" onClick={reload} disabled={loading || saving} aria-label="刷新宝贝资料"><RefreshCw size={18} />刷新</Button>
    } />
    {loading && !data ? <LoadingState /> : error ? <ErrorState error={error} onRetry={reload} /> : <>
      <Card className="profile-identity-card">
        <div className="profile-identity">
          <WatchAvatar watchId={watchId} name={data?.account?.name || '宝贝'} className="device-data-symbol profile-avatar" />
          <div className="profile-identity-copy"><h2>{data?.account?.name || '宝贝'}</h2><p>{data?.account?.model || '当前手表'}{data?.account?.number ? ` · ${data.account.number}` : ''}</p></div>
          {dirty && <Badge>尚未保存</Badge>}
        </div>
      </Card>
      <form id={formId} onSubmit={save} className="profile-form-layout">
        <fieldset className="profile-fields" disabled={saving}>
          <Card className="profile-basic-card" title={<span className="device-data-card-title"><UserRound size={22} aria-hidden="true" />基本资料</span>} description="设置手表中显示的称呼，以及宝贝的个人信息。">
            <div className="form-grid">
              <Field label="昵称" hint="手表中显示的名字。"><Input name="name" value={values.name} onChange={e => change('name', e.target.value)} autoComplete="off" placeholder="请输入昵称" /></Field>
              <Field label="真实姓名"><Input name="realName" value={values.realName} onChange={e => change('realName', e.target.value)} autoComplete="off" placeholder="请输入真实姓名" /></Field>
              <Field label="生日"><Input name="birthday" type="date" value={values.birthday} onChange={e => change('birthday', e.target.value)} /></Field>
              <Field label="性别"><Select name="gender" value={values.gender} onChange={e => change('gender', e.target.value)}><option value="">未设置</option><option value="0">男孩</option><option value="1">女孩</option></Select></Field>
            </div>
          </Card>
          <Card title={<span className="device-data-card-title"><Heart size={22} aria-hidden="true" />成长信息</span>} description="记录当前的身高和体重。">
            <div className="form-grid">
              <Field label="身高（cm）"><Input name="height" type="number" min="0" value={values.height} onChange={e => change('height', e.target.value)} placeholder="厘米" /></Field>
              <Field label="体重（kg）"><Input name="weight" type="number" min="0" step="0.1" value={values.weight} onChange={e => change('weight', e.target.value)} placeholder="千克" /></Field>
            </div>
          </Card>
          <Card title={<span className="device-data-card-title"><GraduationCap size={22} aria-hidden="true" />学校信息</span>} description="填写宝贝所在的年级和班级。">
            <div className="form-grid">
              <Field label="年级"><Input name="grade" type="number" value={values.grade} onChange={e => change('grade', e.target.value)} /></Field>
              <Field label="班级"><Input name="classes" type="number" value={values.classes} onChange={e => change('classes', e.target.value)} /></Field>
            </div>
          </Card>
        </fieldset>
        <div className="profile-save-row"><p>保存后，修改内容会同步到当前手表。</p><Button type="submit" loading={saving}><Save size={18} />保存资料</Button></div>
      </form>
    </>}
  </div>;
}
