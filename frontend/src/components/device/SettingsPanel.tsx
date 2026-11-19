import React, { useEffect, useState } from 'react';
import { Bell, Clock3, Globe2, MessageSquare, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Volume2 } from 'lucide-react';
import { api, post } from '../../lib/api';
import { useResource } from '../../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, Modal, PageHeader, Tabs, Toggle, toast } from '../ui';
import DeviceForm, { DataRows, formatWeekdays, type DeviceField } from './DeviceForm';

type Props = { watchId: string; caps?: any };
type Editor = { title: string; description?: string; fields: DeviceField[]; submit: (values: Record<string, string>) => Promise<void> };
type Confirmation = { title: string; description: string; run: () => Promise<void> };
type Capability = { state: 'unknown' | 'on' | 'off' | 'useless'; ok: boolean; tips: string };

const weekText = formatWeekdays;
const onOff = (value: any, on = '开启', off = '关闭') => value == null ? '未获取' : Number(value) === 1 ? on : off;
const languages: Record<string, string> = { 'zh-CN': '简体中文', 'zh-HK': '繁体中文（香港）', 'zh-TW': '繁体中文（台湾）', en: 'English' };
const switchField = (name: string, label: string, value: any, yes = '开启', no = '关闭'): DeviceField => ({
  name, label, type: 'select', value: String(value ?? 0), options: [{ value: '1', label: yes }, { value: '0', label: no }],
});
const weekField = (value: any): DeviceField => ({ name: 'classWeek', label: '重复日期', type: 'weekdays', value: value ?? 31 });
const parsePeriods = (value: any): any[] => {
  if (Array.isArray(value)) return value;
  try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
};

function CapabilityNote({ capability }: { capability: Capability }) {
  return <p className="muted">{capability.tips || '当前手表型号暂不可使用此功能。'}</p>;
}

export default function SettingsPanel({ watchId, caps }: Props) {
  const base = `/api/watch/${encodeURIComponent(watchId)}`;
  const settings = useResource(() => watchId ? api(`${base}/settings`) : Promise.resolve(null), [watchId]);
  const d: any = settings.data || {};
  const [tab, setTab] = useState('daily');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState('');
  useEffect(() => { setEditor(null); setConfirmation(null); setPending(''); }, [watchId]);

  const capability = (ids: number | number[]): Capability => {
    const map = d.capabilities || caps?.capabilities || caps?.modules || caps?.map || caps || {};
    const list = Array.isArray(ids) ? ids : [ids];
    const found = list.map((id) => map[id]).filter((x) => x && x.display != null);
    if (!found.length || found.length < list.length && !found.some((x) => Number(x.display) === 0)) return { state: 'unknown', ok: true, tips: '' };
    if (found.some((x) => Number(x.display) === 0)) return { state: 'on', ok: true, tips: '' };
    return { state: found.some((x) => Number(x.display) === 2) ? 'useless' : 'off', ok: false, tips: found.find((x) => x.tips)?.tips || '' };
  };
  const autoCallCapability = capability(13);
  const autoCall = useResource(() => watchId && settings.data && autoCallCapability.ok ? api(`${base}/autocall`) : Promise.resolve(null), [watchId, !!settings.data, autoCallCapability.ok]);
  const chatControl = useResource(() => watchId ? api(`${base}/chatcontrol`) : Promise.resolve(null), [watchId]);

  if (!watchId) return <EmptyState title="请先选择一块手表" description="选择手表后，可以管理它的声音、使用时段和其他设置。" />;
  if (settings.loading && !settings.data) return <LoadingState />;
  if (settings.error && !settings.data) return <ErrorState error={settings.error} onRetry={settings.reload} />;

  const volume = d.volume || {}, sms = d.sms || {}, endurance = d.endurance || {};
  const disableMode = d.disableMode || {}, systemMode = d.systemMode || {}, beforeSchool = d.beforeSchool || {};
  const timezone = d.timezone || {}, chargeAlert = d.chargeAlert || {}, receiveType = d.receiveType || {};
  const classModes = Array.isArray(d.classModes) ? d.classModes : [];
  const sleepCapability = capability(2757), classCapability = capability(2872);
  const flowCapability = capability(61), languageCapability = capability(240), zoneCapability = capability([2699, 241]);

  async function run(key: string, action: () => Promise<any>, reload: () => any = settings.reload) {
    if (pending) return;
    setPending(key);
    try { await action(); await reload(); toast('设置已保存', 'success'); }
    catch (error: any) { toast(error?.message || '操作失败，请重试', 'danger'); }
    finally { setPending(''); }
  }
  function edit(title: string, endpoint: string, fields: DeviceField[], transform?: (v: Record<string, string>) => any, method = 'POST', description?: string) {
    setEditor({ title, fields, description, submit: async (values) => {
      await api(`${base}/settings/${endpoint}`, { method, body: transform ? transform(values) : values });
      await settings.reload();
    } });
  }
  function confirm(title: string, description: string, action: () => Promise<any>) {
    setConfirmation({ title, description, run: async () => { await action(); await settings.reload(); } });
  }
  function timeForm(type: number, item: any = {}) {
    edit(item.id ? '编辑时段' : type === 1 ? '添加睡眠时段' : '添加定时开关机', 'time', [
      { name: 'name', label: '名称', value: item.name || (type === 1 ? '睡眠模式' : '定时开关机') },
      { name: 'startTime', label: '开始时间', type: 'time', required: true, value: String(item.startTime || (type === 1 ? '22:00' : '07:00')).slice(0, 5) },
      { name: 'endTime', label: '结束时间', type: 'time', required: true, value: String(item.endTime || (type === 1 ? '06:00' : '21:00')).slice(0, 5) },
      weekField(item.classWeek),
    ], (values) => ({ ...values, type, ...(item.id ? { id: item.id } : {}) }), item.id ? 'PUT' : 'POST');
  }
  function classForm(item: any = {}) {
    const id = item.classId || item.id;
    const periods = parsePeriods(item.timePeriod);
    edit(id ? '编辑上课禁用时段' : '添加上课禁用时段', id ? `classmode/${encodeURIComponent(id)}` : 'classmode/add', [
      { name: 'title', label: '名称', value: item.title || '上课禁用' },
      { name: 'startTime', label: '开始时间', type: 'time', value: String(periods[0]?.startTime || '08:00').slice(0, 5), required: true },
      { name: 'endTime', label: '结束时间', type: 'time', value: String(periods[0]?.endTime || '11:30').slice(0, 5), required: true },
      weekField(item.classWeek),
      switchField('holidaySwitch', '法定节假日不生效', item.holidaySwitch ?? 1, '是', '否'),
    ], undefined, id ? 'PUT' : 'POST');
  }
  function scheduleList(list: any, type: number) {
    const items = Array.isArray(list) ? list : [];
    return <div className="stack device-schedule-list">{!items.length && <p className="muted">还没有设置时段</p>}{items.map((item) => <div className="device-schedule-row" key={item.id}>
      <div className="device-item-main"><strong className="device-item-title">{item.name || '时段'}</strong><p className="device-schedule-time">{String(item.startTime || '').slice(0, 5)}–{String(item.endTime || '').slice(0, 5)}</p><p className="device-item-description">{weekText(item.classWeek)}</p></div>
      <Badge tone={Number(item.switchStatus) === 1 ? 'success' : 'neutral'}>{onOff(item.switchStatus)}</Badge>
      <Button variant="ghost" size="icon" aria-label={`编辑${item.name || '时段'}`} onClick={() => timeForm(type, item)}><Pencil size={18} /></Button>
      <Button variant="ghost" size="icon" aria-label={`删除${item.name || '时段'}`} onClick={() => confirm('删除时段', `确认删除「${item.name || '此时段'}」？`, () => api(`${base}/settings/time/${encodeURIComponent(item.id)}?type=${type}`, { method: 'DELETE' }))}><Trash2 size={18} /></Button>
    </div>)}<div><Button variant="secondary" onClick={() => timeForm(type)}><Plus size={16} />添加时段</Button></div></div>;
  }

  return <div className="device-settings-page stack">
    <PageHeader title="设备设置" description="声音、使用时段、通讯权限与系统设置。" actions={<Button variant="secondary" onClick={settings.reload} disabled={settings.loading}><RefreshCw size={19} />刷新设置</Button>} />
    <div className="device-settings-context">
      <p>型号 {d.watch?.innerModel || d.watch?.model || '未获取'}<span>固件 {d.watch?.firmware || '未获取'}</span></p>
      {d.capabilityStale ? <Badge tone="warning">使用上次的型号能力</Badge> : d.capabilityOk === false ? <Badge>通用设置</Badge> : null}
    </div>
    {settings.error && <ErrorState error={settings.error} onRetry={settings.reload} />}
    <Tabs value={tab} onChange={setTab} items={[{ value: 'daily', label: <><Volume2 size={18} aria-hidden="true" />声音与生活</> }, { value: 'schedule', label: <><Clock3 size={18} aria-hidden="true" />时间与模式</> }, { value: 'calls', label: <><ShieldCheck size={18} aria-hidden="true" />通话与隐私</> }, { value: 'system', label: <><Globe2 size={18} aria-hidden="true" />系统与网络</> }]} />

    {tab === 'daily' && <div className="grid-2 device-settings-panels">
      <Card title="音量与铃声" description="调整手表声音模式与音量。" action={<Volume2 size={19} />}>
        <DataRows items={[{ label: '声音模式', value: volume.soundMode }, { label: '音量', value: `${volume.soundLevel ?? '—'} / ${volume.totalLevel ?? '—'}` }, { label: '禁用模式', value: volume.disableMode }, { label: '默认模式', value: volume.modeDefault }]} />
        <Button variant="secondary" onClick={() => edit('修改音量', 'volume', [
          { name: 'soundMode', label: '声音模式', type: 'number', value: volume.soundMode ?? 0 },
          { name: 'soundLevel', label: '当前音量', type: 'number', min: 0, value: volume.soundLevel ?? '' },
          { name: 'totalLevel', label: '最大音量', type: 'number', min: 0, value: volume.totalLevel ?? '' },
          { name: 'disableMode', label: '禁用模式', type: 'number', value: volume.disableMode ?? 0 },
          { name: 'modeDefault', label: '默认模式', value: volume.modeDefault || '' },
        ])}>修改音量</Button>
      </Card>
      <Card title="短信同步" description="查看同步状态，调整短信接收范围。" action={<MessageSquare size={19} />}>
        <DataRows items={[{ label: '短信同步', value: onOff(sms.smsSync) }, { label: '接收类型', value: receiveType.receiveType }, { label: '展示全部', value: onOff(receiveType.isDisplayAll, '是', '否') }]} />
        <Button variant="secondary" onClick={() => edit('短信接收设置', 'receivetype', [
          { name: 'receiveType', label: '接收类型', type: 'number', value: receiveType.receiveType ?? 0 },
          switchField('isDisplayAll', '展示全部', receiveType.isDisplayAll ?? 1, '是', '否'),
        ])}>修改接收设置</Button>
      </Card>
      <Card title="生活提醒" action={<Bell size={19} />}>
        <DataRows items={[{ label: '喝水提醒', value: onOff(d.waterSwitch) }, { label: '提醒间隔', value: d.waterInterval ? `${Math.round(Number(d.waterInterval) / 60)} 分钟` : '未设置' }]} />
        <div className="stack"><Button variant="secondary" onClick={() => edit('设置喝水提醒', 'watchswitch', [switchField('waterSwitch', '喝水提醒', d.waterSwitch), { name: 'minutes', label: '提醒间隔（分钟）', type: 'number', min: 1, value: d.waterInterval ? Math.round(Number(d.waterInterval) / 60) : 40 }], (values) => ({ waterSwitch: values.waterSwitch, waterInterval: Number(values.minutes) * 60 }))}>设置喝水提醒</Button>
          <Toggle label="低电量保护" checked={Number(d.powerLowProtectSwitch) === 1} disabled={!!pending} onChange={(checked) => run('low-power', () => post(`${base}/settings/watchswitch`, { powerLowProtectSwitch: checked ? 1 : 0 }))} /></div>
      </Card>
      <Card title="省电设置" description="在续航时间与功能使用之间选择适合的模式。">
        <DataRows items={[{ label: '省电模式', value: ['标准模式', '超长待机', '智能省电'][Number(endurance.enduranceType)] || endurance.enduranceType }, { label: '自动切换', value: onOff(endurance.autoSwitch) }, { label: '电量阈值', value: endurance.threshold != null ? `${endurance.threshold}%` : null }, { label: '智能省电', value: onOff(endurance.smartPowerSaveSwitch) }]} />
        <div className="action-row"><Button variant="secondary" onClick={() => edit('切换省电模式', 'endurance', [{ name: 'enduranceType', label: '省电模式', type: 'select', value: String(endurance.enduranceType ?? 0), options: [{ value: '0', label: '标准模式' }, { value: '1', label: '超长待机' }, { value: '2', label: '智能省电' }] }])}>切换模式</Button>
          <Button variant="secondary" onClick={() => edit('省电自动设置', 'endurance', [switchField('autoSwitch', '自动切换', endurance.autoSwitch), { name: 'threshold', label: '电量阈值（%）', type: 'number', min: 0, max: 100, value: endurance.threshold ?? 20 }, switchField('smartPowerSaveSwitch', '智能省电', endurance.smartPowerSaveSwitch)])}>自动设置</Button></div>
      </Card>
    </div>}

    {tab === 'schedule' && <div className="grid-2 device-settings-panels">
      <Card title="定时开关机" action={<Clock3 size={19} />}>{scheduleList(d.time0, 0)}</Card>
      {sleepCapability.state !== 'off' && <Card title="睡眠模式">{sleepCapability.ok ? scheduleList(d.time1, 1) : <CapabilityNote capability={sleepCapability} />}</Card>}
      {classCapability.state !== 'off' && <Card title="上课禁用" description="按上课安排设定禁用时段。">
        {!classCapability.ok ? <CapabilityNote capability={classCapability} /> : <div className="stack">
          {!classModes.length && <p className="muted">还没有设置上课禁用时段</p>}
          {classModes.map((item: any) => <div className="device-schedule-row" key={item.classId || item.id}>
            <div className="device-item-main"><strong className="device-item-title">{item.title || '上课禁用'}</strong><p className="device-schedule-time">{parsePeriods(item.timePeriod).map((p) => `${String(p.startTime || '').slice(0, 5)}–${String(p.endTime || '').slice(0, 5)}`).join('、') || '未设置时段'}</p><p className="device-item-description">{weekText(item.classWeek)}</p></div>
            <Badge tone={Number(item.classSwitch) === 1 ? 'success' : 'neutral'}>{onOff(item.classSwitch, '生效', '停用')}</Badge>
            <Button variant="ghost" size="icon" aria-label={`编辑${item.title || '上课时段'}`} onClick={() => classForm(item)}><Pencil size={18} /></Button>
            <Button variant="ghost" size="icon" aria-label={`删除${item.title || '上课时段'}`} onClick={() => confirm('删除上课时段', `确认删除「${item.title || '此时段'}」？`, () => api(`${base}/settings/classmode/${encodeURIComponent(item.classId || item.id)}`, { method: 'DELETE' }))}><Trash2 size={18} /></Button>
          </div>)}
          <div><Button variant="secondary" onClick={() => classForm()}><Plus size={16} />添加上课时段</Button></div>
        </div>}
      </Card>}
      <Card title="模式限制" description="分别设置上课、睡眠和续航模式下的聊天与通话权限。">
        <DataRows items={['classMode', 'sleepMode', 'endurance'].map((prefix, i) => ({ label: ['上课：聊天 / 通话', '睡眠：聊天 / 通话', '续航：聊天 / 通话'][i], value: `${onOff(disableMode[`${prefix}Weichat`], '允许', '禁止')} / ${onOff(disableMode[`${prefix}Call`], '允许', '禁止')}` }))} />
        <Button variant="secondary" onClick={() => edit('编辑模式限制', 'disablemode', ['classMode', 'sleepMode', 'endurance'].flatMap((prefix, i) => [switchField(`${prefix}Weichat`, `${['上课', '睡眠', '续航'][i]} · 聊天`, disableMode[`${prefix}Weichat`], '允许', '禁止'), switchField(`${prefix}Call`, `${['上课', '睡眠', '续航'][i]} · 通话`, disableMode[`${prefix}Call`], '允许', '禁止')]))}>编辑模式限制</Button>
      </Card>
      <Card title="系统模式"><p>{Number(systemMode.status) === 1 ? '当前为超长待机模式' : '当前为标准模式'}</p><Button variant="secondary" onClick={() => confirm('切换系统模式', Number(systemMode.status) === 1 ? '将手表切回标准模式？' : '将手表切换至超长待机模式？', () => post(`${base}/settings/systemmode`, { status: Number(systemMode.status) === 1 ? 0 : 1 }))}>{Number(systemMode.status) === 1 ? '切回标准模式' : '切换超长待机'}</Button></Card>
      <Card title="上学前模式"><Toggle label="上学前模式" checked={Number(beforeSchool.status) === 1} disabled={!!pending} onChange={(checked) => run('school', () => post(`${base}/settings/beforeschool`, { status: checked ? 1 : 0 }))} /></Card>
    </div>}

    {tab === 'calls' && <div className="grid-2 device-settings-panels">
      <Card title="位置与通话" description="管理定位提醒与互动通话。"><div className="stack">
        <Toggle label="位置上报提醒" checked={Number(d.locationAlertSwitch) === 1} disabled={!!pending} onChange={(checked) => run('location-alert', () => post(`${base}/settings/watchswitch`, { locationAlertSwitch: checked ? 1 : 0 }))} />
        <Toggle label="互动通话" checked={Number(d.interactionCallSwitch) === 1} disabled={!!pending} onChange={(checked) => run('interaction', () => post(`${base}/settings/watchswitch`, { interactionCallSwitch: checked ? 1 : 0 }))} />
      </div></Card>
      {autoCallCapability.state !== 'off' && <Card title="自动接听授权" description="选择可以自动接听手表来电的联系人。">
        {!autoCallCapability.ok ? <CapabilityNote capability={autoCallCapability} /> : autoCall.loading && !autoCall.data ? <LoadingState /> : autoCall.error ? <ErrorState error={autoCall.error} onRetry={autoCall.reload} /> : <div className="stack">
          {!((autoCall.data as any)?.contacts || []).length && <p className="muted">暂无可授权的联系人</p>}
          {((autoCall.data as any)?.contacts || []).map((contact: any) => <div key={contact.id} className="device-inline-toggle"><div className="device-item-main"><strong className="device-item-title">{contact.name}</strong><p className="device-item-description">{contact.number || contact.shortNumber || '未填写号码'}</p></div><Toggle label={`允许${contact.name}自动接听`} checked={!!contact.autoCall} disabled={!!pending} onChange={(checked) => run(`auto-${contact.id}`, () => post(`${base}/autocall`, { id: contact.id, autoCall: checked }), autoCall.reload)} /></div>)}
        </div>}
      </Card>}
      <Card title="聊天管控" description="管理陌生人添加好友和功能开关。" action={<ShieldCheck size={19} />}>
        {chatControl.loading && !chatControl.data ? <LoadingState /> : chatControl.error ? <ErrorState error={chatControl.error} onRetry={chatControl.reload} /> : <div className="stack">
          <Toggle label="加好友需要家长审核" checked={Number((chatControl.data as any)?.parentAudit?.v) === 1} disabled={!!pending} onChange={(checked) => run('parent-audit', () => post(`${base}/chatcontrol/parentaudit`, { v: checked ? 1 : 0 }), chatControl.reload)} />
          <DataRows items={((chatControl.data as any)?.subs || []).map((item: any) => ({ label: item.switchName || '功能开关', value: onOff(item.switchStatus) }))} />
        </div>}
      </Card>
      <Card title="隐私与数据" description="开关保存成功后才会更新界面状态。">
        {chatControl.loading && !chatControl.data ? <LoadingState /> : chatControl.error ? <ErrorState error={chatControl.error} onRetry={chatControl.reload} /> : <div className="stack">
          {!((chatControl.data as any)?.privacy || []).length && <p className="muted">暂无可调整的隐私设置</p>}
          {((chatControl.data as any)?.privacy || []).map((item: any) => <div className="device-inline-toggle" key={item.switchId}><div className="device-item-main"><strong className="device-item-title">{item.name || `设置 ${item.switchId}`}</strong>{item.description && <p className="device-item-description">{item.description}</p>}</div><Toggle label={item.name || '隐私设置'} checked={Number(item.status) === 1} disabled={!!pending} onChange={(checked) => run(`privacy-${item.switchId}`, () => post(`${base}/chatcontrol/privacy`, { switchId: Number(item.switchId), status: checked ? 1 : 0 }), chatControl.reload)} /></div>)}
        </div>}
      </Card>
    </div>}

    {tab === 'system' && <div className="grid-2 device-settings-panels">
      {flowCapability.state !== 'off' && <Card title="流量限制" description="设置手表可使用的流量上限。">
        {flowCapability.ok ? <><DataRows items={[{ label: '流量上限', value: d.flow?.stream != null ? `${d.flow.stream} KB` : null }]} /><Button variant="secondary" onClick={() => edit('流量限制', 'flow', [{ name: 'stream', label: '流量上限（KB）', type: 'number', min: 0, required: true, value: d.flow?.stream ?? '' }])}>修改上限</Button></> : <CapabilityNote capability={flowCapability} />}
      </Card>}
      {(languageCapability.state !== 'off' || zoneCapability.state !== 'off') && <Card title="语言与时区" action={<Globe2 size={19} />}>
        <DataRows items={[...(languageCapability.state !== 'off' ? [{ label: '手表语言', value: languages[timezone.language] || timezone.language }] : []), ...(zoneCapability.state !== 'off' ? [{ label: '时区', value: [timezone.globalTimeZoneV2, timezone.globalTimeZone].filter(Boolean).join(' ') }] : [])]} />
        <div className="action-row">{languageCapability.state !== 'off' && <Button variant="secondary" disabled={!languageCapability.ok} title={languageCapability.tips} onClick={() => {
          const list = d.languages?.appDisplayLanguages || d.languages?.watchSupportLanguages || [];
          if (!Array.isArray(list) || !list.length) { toast('未获取到手表支持的语言列表', 'danger'); return; }
          const options = list.map((x: any) => { const code = typeof x === 'object' ? x.language || x.code || x.value || '' : String(x); return { value: code, label: languages[code] || code }; });
          edit('手表语言', 'language', [{ name: 'language', label: '语言', type: 'select', value: timezone.language || options[0].value, options }]);
        }}>修改语言</Button>}
        {zoneCapability.state !== 'off' && <Button variant="secondary" disabled={!zoneCapability.ok || !!pending} title={zoneCapability.tips} onClick={async () => {
          setPending('timezones');
          try { const result: any = await api(`${base}/settings/timezones`); const list = result.list || []; if (!list.length) throw new Error('未获取到时区列表'); edit('手表时区', 'timezone', [{ name: 'zoneKey', label: '时区', type: 'select', value: timezone.globalTimeZoneV2 || 'Asia/Shanghai', options: list.map((x: any) => ({ value: x.k, label: `${x.v?.['zh-CN'] || x.v?.en || x.k} (${x.gmt || ''})` })) }]); }
          catch (error: any) { toast(error?.message || '时区加载失败', 'danger'); } finally { setPending(''); }
        }}>修改时区</Button>}</div>
      </Card>}
      <Card title="话费提醒"><Toggle label="话费提醒" checked={Number(chargeAlert.chargeSwitch) === 1} disabled={!!pending} onChange={(checked) => run('charge-alert', () => post(`${base}/settings/chargealert`, { chargeSwitch: checked ? 1 : 0 }))} /></Card>
      <Card title="话费信息"><DataRows items={[{ label: '当前话费', value: d.charges?.phoneCharges != null ? `${d.charges.phoneCharges} 元` : null }, { label: '查询次数', value: d.charges?.totalCount }, { label: '成功次数', value: d.charges?.successCount }]} /></Card>
    </div>}

    {editor && <DeviceForm key={editor.title} title={editor.title} description={editor.description} fields={editor.fields} onClose={() => setEditor(null)} onSubmit={editor.submit} />}
    <Modal open={!!confirmation} closeable={!pending} title={confirmation?.title || '确认操作'} onClose={() => { if (!pending) setConfirmation(null); }} footer={<><Button variant="secondary" disabled={!!pending} onClick={() => setConfirmation(null)}>取消</Button><Button variant={confirmation?.title.includes('删除') ? 'danger' : 'primary'} disabled={!!pending} onClick={async () => {
      if (!confirmation || pending) return;
      setPending('confirm');
      try { await confirmation.run(); setConfirmation(null); toast('操作已完成', 'success'); } catch (error: any) { toast(error?.message || '操作失败', 'danger'); } finally { setPending(''); }
    }}>{pending === 'confirm' ? '处理中…' : '确认'}</Button></>}><p>{confirmation?.description}</p></Modal>
  </div>;
}
