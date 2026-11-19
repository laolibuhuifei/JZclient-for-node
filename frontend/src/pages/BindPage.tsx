import React, { FormEvent, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronRight, KeyRound, Search, ShieldCheck, UserRound, Watch } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, LoadingState, Modal, PageHeader, Select, toast } from '../components/ui';
import { errorText } from '../components/extensions/utils';
import '../components/extensions/extensions.css';
import '../components/extensions/bind-md3.css';

export default function BindPage() {
  const { account, tokenInvalid, navigate, refreshAll } = useApp();
  const auth = useResource<any>((signal) => api('/api/account', { signal }), []);
  const session = auth.data || account;
  const [bindNumber, setBindNumber] = useState('');
  const [queriedNumber, setQueriedNumber] = useState('');
  const [result, setResult] = useState<any>(null);
  const [watchCode, setWatchCode] = useState('');
  const [salutation, setSalutation] = useState('家长');
  const [adminNumber, setAdminNumber] = useState('');
  const [requireAdmin, setRequireAdmin] = useState(false);
  const [talentId, setTalentId] = useState('');
  const [recovery, setRecovery] = useState('0');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  const [success, setSuccess] = useState<any>(null);
  const [pending, setPending] = useState<any>(null);
  const [transferPhone, setTransferPhone] = useState('');
  const [transferCode, setTransferCode] = useState('');
  const [sentCode, setSentCode] = useState<any>(null);
  const [confirmMigration, setConfirmMigration] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);
  const watch = result?.watch || {};
  const admin = result?.admin;
  const talents: any[] = result?.talents || [];
  const talent = talents.find((entry) => String(entry.id) === talentId);
  const migrating = !!(talent && String(talent.watchId) !== String(watch.watchId));
  const codeOnly = result?.needCode && !result?.watch;

  async function lookup(event?: FormEvent) {
    event?.preventDefault();
    if (busy) return;
    const number = bindNumber.trim();
    if (!number) { setError('请输入手表绑定号'); return; }
    setBusy('lookup'); setError(''); setHint(''); setSuccess(null);
    try {
      const response = await post('/api/bind/lookup', { bindNumber: number, randcode: watchCode.trim() || undefined });
      setResult(response); setQueriedNumber(number); setTalentId(''); setRecovery('0');
      setAdminNumber(response?.admin?.mobileNumber?.includes('*') ? '' : response?.admin?.mobileNumber || '');
      setRequireAdmin(!!response?.needMobileCheck);
      setHint(response?.hint || '');
      if (response?.needCode) window.setTimeout(() => codeRef.current?.focus(), 0);
    } catch (err) { setError(errorText(err)); }
    finally { setBusy(''); }
  }

  function payload() {
    const body: Record<string, any> = {
      bindNumber: queriedNumber, watchId: watch.watchId, type: admin ? 3 : 0,
      salutation: salutation.trim() || '家长', randcode: watchCode.trim() || undefined,
    };
    if (admin && requireAdmin) body.adminNumber = adminNumber.trim();
    if (migrating) Object.assign(body, {
      origGeniusId: talent.id, origWatchId: talent.watchId,
      origBindNumber: talent.bindNumber, recovery: Number(recovery),
    });
    return body;
  }

  async function submit(body: Record<string, any>) {
    setBusy('submit'); setError(''); setHint('');
    try {
      const response = await post('/api/bind/submit', body);
      if (response?.needAdminNumber) {
        setRequireAdmin(true); setHint(response.hint || '请补充管理员完整手机号');
        return;
      }
      if (response?.needAdminCode) {
        if (body.transferCode) toast('管理员验证码不正确或已过期，请重新确认', 'error');
        else { setSentCode(null); setTransferCode(''); }
        setPending({ ...body, transferCode: undefined });
        setHint(response.hint || '需要旧手表管理员协助验证');
        return;
      }
      if (response?.needCode) {
        setPending(null);
        setResult({ needCode: true, hint: response.hint });
        setWatchCode('');
        setHint(response.hint || '请输入手表上显示的验证码后继续');
        window.setTimeout(() => codeRef.current?.focus(), 0);
        return;
      }
      setPending(null); setSuccess(response); setTransferCode(''); setWatchCode('');
      toast(response?.transferred ? '天才号已迁移并绑定成功' : '绑定成功', 'success');
      await refreshAll();
    } catch (err) {
      setError(errorText(err));
      if (pending) toast(errorText(err), 'error');
    } finally { setBusy(''); }
  }

  function beginSubmit(event: FormEvent) {
    event.preventDefault();
    if (admin && requireAdmin && !adminNumber.trim()) { setError('请输入管理员完整手机号'); return; }
    if (!admin && result?.geniusLimit?.isLimit && !talentId) { setError(result.geniusLimit.limitTipsText || '天才号数量已达上限，请选择已有账号'); return; }
    if (migrating) { setConfirmMigration(true); return; }
    submit(payload());
  }

  async function sendTransferCode() {
    if (!transferPhone.trim()) { toast('请输入旧手表管理员手机号', 'error'); return; }
    setBusy('code');
    try {
      const response = await post('/api/bind/transfercode', { origWatchId: pending.origWatchId, phone: transferPhone.trim() });
      setSentCode(response); toast('管理员验证码已发送', 'success');
    } catch (err) { toast(errorText(err), 'error'); }
    finally { setBusy(''); }
  }

  function reset() {
    setResult(null); setSuccess(null); setError(''); setHint(''); setWatchCode('');
    setBindNumber(''); setQueriedNumber(''); setPending(null); setSentCode(null); setTalentId('');
  }

  return <div className="stack extensions-page bind-page">
    <PageHeader title="绑定手表" description="连接一块新手表，或把已有天才号迁移过来。" />
    {auth.loading && !session ? <LoadingState /> : auth.error && !session ? <ErrorState error={auth.error} onRetry={auth.reload} /> : !session?.loggedIn || tokenInvalid ?
      <Card className="bind-login-card"><EmptyState icon={<ShieldCheck size={30} />} title={tokenInvalid ? '家长账号登录已失效' : '先登录家长账号'} description="登录后才能查询绑定信息，并将手表关联到你的账号。" action={<Button onClick={() => navigate('account')}>登录家长账号 <ArrowRight size={18} /></Button>} /></Card> : success ?
      <Card className="extension-bind-success bind-success">
        <span className="extension-success-icon"><Check size={32} strokeWidth={2} /></span>
        <h2>{success.transferred ? '迁移与绑定已完成' : '绑定已完成'}</h2>
        <p className="muted">手表列表已刷新，可以返回主页查看设备。</p>
        {queriedNumber && <p className="bind-success-number">绑定号 <span className="mono">{queriedNumber}</span></p>}
        <div className="action-row"><Button onClick={() => navigate('home')}>查看手表<ArrowRight size={18} /></Button><Button variant="secondary" onClick={reset}>继续绑定</Button></div>
      </Card> : <>
      <ol className="bind-progress" aria-label="绑定进度">
        <li className={result?.watch ? 'complete' : 'active'} aria-current={!result?.watch ? 'step' : undefined}><span className="bind-step-number">{result?.watch ? <Check size={18} /> : '1'}</span><span>查询手表</span></li>
        <li className={result?.watch ? 'active' : ''} aria-current={result?.watch ? 'step' : undefined}><span className="bind-step-number">2</span><span>确认信息</span></li>
        <li><span className="bind-step-number">3</span><span>完成绑定</span></li>
      </ol>
      <div className="bind-layout">
        <div className="bind-workspace">
          <Card className="bind-lookup-card" title="查找你的手表" description="绑定号可以在手表的绑定页面或包装信息中找到。">
            <form className="extension-lookup-form" onSubmit={lookup} aria-busy={busy === 'lookup'}>
              <Field label="绑定号"><Input value={bindNumber} placeholder="输入 16 位绑定号" autoComplete="off" inputMode="numeric" disabled={!!busy} onChange={(event) => { setBindNumber(event.target.value); setResult(null); setError(''); setHint(''); setWatchCode(''); }} /></Field>
              <Button type="submit" loading={busy === 'lookup'} disabled={!!busy || !bindNumber.trim()}>{busy !== 'lookup' && <Search size={18} />}{busy === 'lookup' ? '查询中…' : '查询绑定号'}</Button>
            </form>
            {codeOnly && <form className="bind-code-section" onSubmit={lookup}>
              <div className="bind-notice" role="status"><KeyRound size={20} /><span>{hint || '请查看手表屏幕上的验证码。'}</span></div>
              <div className="bind-code-form"><Field label="手表验证码"><Input ref={codeRef} value={watchCode} autoComplete="one-time-code" inputMode="numeric" disabled={!!busy} onChange={(event) => setWatchCode(event.target.value)} /></Field><Button type="submit" loading={busy === 'lookup'} disabled={!!busy || !watchCode.trim()}>验证并查询<ArrowRight size={18} /></Button></div>
            </form>}
          </Card>
          {error && <div className="extension-error bind-error" role="alert">{error}</div>}
          {result?.watch && <Card className="bind-confirm-card" title="确认绑定信息" action={<Badge tone={admin ? 'neutral' : 'info'}>{admin ? '已有管理员' : '新手表'}</Badge>}>
            <div className="bind-watch-identity"><span className="bind-watch-symbol"><Watch size={30} strokeWidth={1.7} /></span><div><h3>{watch.model || '电话手表'}</h3><p>设备 ID <span className="mono">{watch.watchId}</span></p></div></div>
            {result.alreadyBound ? <div className="bind-notice bind-notice-success"><Check size={20} /><div>当前账号已经绑定这块手表，无需重复绑定。<div className="action-row"><Button variant="secondary" onClick={() => navigate('home')}>返回主页<ArrowRight size={18} /></Button></div></div></div> :
              <form className="bind-confirm-form" onSubmit={beginSubmit} aria-busy={busy === 'submit'}>
                <div className="bind-form-section">
                  <h3>家庭与账号</h3>
                  {admin && <dl className="bind-admin-summary"><dt>当前管理员</dt><dd>{admin.salutation || '管理员'}{admin.mobileNumber ? ' · ' + admin.mobileNumber : ''}</dd></dl>}
                  <div className="form-grid">
                    <Field label="绑定方式"><Select value={admin ? '3' : '0'} disabled><option value={admin ? '3' : '0'}>{admin ? '申请加入已有家庭' : '绑定为管理员'}</option></Select></Field>
                    {admin && requireAdmin && <Field label="管理员完整手机号"><Input value={adminNumber} type="tel" autoComplete="tel" onChange={(event) => setAdminNumber(event.target.value)} disabled={!!busy} required /></Field>}
                    {!admin && !!talents.length && <Field label="手表端登录账号"><Select value={talentId} disabled={!!busy} onChange={(event) => { setTalentId(event.target.value); setSentCode(null); }}><option value="" disabled={!!result?.geniusLimit?.isLimit}>创建新的天才号</option>{talents.map((entry) => <option key={entry.id} value={String(entry.id)}>{entry.geniusNumber || entry.id} · {entry.name || '未命名'}{entry.bindNumber ? ' · ' + entry.bindNumber : ''}{entry.isLogin === 1 ? '（登录中）' : ''}</option>)}</Select></Field>}
                  </div>
                  {!admin && result.geniusLimit?.isLimit && <p className="bind-notice">{result.geniusLimit.limitTipsText || '天才号数量已达上限，请选择已有账号。'}</p>}
                  {!admin && talent && !migrating && <p className="bind-field-note">这个天才号已在当前手表上登录，无需迁移。</p>}
                  {!admin && !talent && !result.geniusLimit?.isLimit && <p className="bind-field-note">绑定完成后，由手表端注册生成新的天才号。</p>}
                  {migrating && <div className="bind-migration">
                    <div className="bind-migration-heading"><UserRound size={20} /><h4>迁移已有天才号</h4></div>
                    <div className="bind-transfer-path"><span>{talent.bindNumber || '旧手表'}</span><ChevronRight size={18} aria-hidden="true" /><span>{queriedNumber}</span></div>
                    <p>迁移后，旧手表会恢复未绑定状态。你可以选择保留旧手表上的数据。</p>
                    <Field label="旧手表数据"><Select value={recovery} disabled={!!busy} onChange={(event) => setRecovery(event.target.value)}><option value="0">保留旧表数据</option><option value="1">不保留旧表数据</option></Select></Field>
                  </div>}
                </div>
                <div className="bind-form-section">
                  <h3>称呼与验证</h3>
                  <div className="form-grid"><Field label="你的称呼"><Input value={salutation} onChange={(event) => setSalutation(event.target.value)} disabled={!!busy} placeholder="家长" /></Field><Field label="手表验证码" hint="如手表提示验证码，请在这里填写。"><Input ref={codeRef} value={watchCode} autoComplete="one-time-code" inputMode="numeric" onChange={(event) => setWatchCode(event.target.value)} disabled={!!busy} /></Field></div>
                  {hint && !pending && <div className="bind-notice" role="status"><KeyRound size={20} /><span>{hint}</span></div>}
                </div>
                <div className="bind-submit-row"><Button type="submit" loading={busy === 'submit'} disabled={!!busy}>{busy === 'submit' ? '提交中…' : admin ? '提交绑定申请' : '确认绑定'}<ArrowRight size={18} /></Button></div>
              </form>}
          </Card>}
        </div>
        <aside className="bind-support" aria-label="绑定说明">
          <Card title="绑定说明" className="bind-guide">
            <ul>
              <li><Watch size={20} /><div><h3>先查找设备</h3><p>输入绑定号，确认型号和设备 ID 是你准备连接的手表。</p></div></li>
              <li><ShieldCheck size={20} /><div><h3>加入正确的家庭</h3><p>已有管理员的手表会提交加入申请；需要验证时，填写管理员完整手机号。</p></div></li>
              <li><UserRound size={20} /><div><h3>选择手表端账号</h3><p>新手表可创建天才号，也可迁移已有账号。迁移前会再次确认数据保留方式。</p></div></li>
            </ul>
          </Card>
          {result?.watch && !result.alreadyBound && <div className="bind-context-note"><KeyRound size={20} /><p>{pending ? '完成管理员验证后，将继续本次迁移。' : migrating ? '这次绑定包含账号迁移。提交后按提示完成管理员验证。' : admin ? '申请将发送给当前手表管理员。' : '核对称呼与验证码后，即可确认绑定。'}</p></div>}
        </aside>
      </div>
    </>}
    <Modal className="bind-dialog" open={confirmMigration} onClose={() => setConfirmMigration(false)} title="确认迁移天才号" description="请核对旧手表和数据保留方式。" footer={<><Button variant="secondary" onClick={() => setConfirmMigration(false)}>返回检查</Button><Button onClick={() => { setConfirmMigration(false); submit(payload()); }}>迁移并绑定<ArrowRight size={18} /></Button></>}>
      <div className="bind-dialog-summary"><dl><div><dt>天才号</dt><dd>{talent?.geniusNumber || talent?.id}</dd></div><div><dt>旧手表绑定号</dt><dd>{talent?.bindNumber || '旧手表'}</dd></div><div><dt>新手表绑定号</dt><dd>{queriedNumber}</dd></div><div><dt>旧手表数据</dt><dd>{recovery === '0' ? '保留旧表数据' : '不保留旧表数据'}</dd></div></dl><p>迁移后，旧手表会恢复未绑定状态。</p></div>
    </Modal>
    <Modal className="bind-dialog" open={!!pending} closeable={!busy} onClose={() => { if (!busy) setPending(null); }} title="管理员验证" description={hint || '请旧手表管理员协助完成迁移验证。'} footer={<><Button variant="secondary" disabled={!!busy} onClick={() => setPending(null)}>稍后验证</Button>{sentCode && <Button loading={busy === 'submit'} disabled={!!busy || !transferCode.trim()} onClick={() => submit({ ...pending, transferCode: transferCode.trim() })}>{busy === 'submit' ? '验证中…' : '验证并继续绑定'}</Button>}</>}>
      <div className="bind-admin-code-form"><Field label="旧手表管理员手机号"><Input type="tel" autoComplete="tel" value={transferPhone} disabled={!!busy} onChange={(event) => { setTransferPhone(event.target.value); setSentCode(null); }} /></Field><div><Button variant="secondary" loading={busy === 'code'} disabled={!!busy || !transferPhone.trim()} onClick={sendTransferCode}>{busy === 'code' ? '发送中…' : sentCode ? '重新发送验证码' : '发送验证码'}</Button></div>{sentCode && <><p className="bind-code-sent" role="status"><Check size={18} /><span>验证码已发送给 {sentCode.adminSalutation || '管理员'} {sentCode.adminPhoneNumber || ''}。</span></p><Field label="管理员收到的验证码"><Input value={transferCode} inputMode="numeric" autoComplete="one-time-code" disabled={!!busy} onChange={(event) => setTransferCode(event.target.value)} /></Field></>}</div>
    </Modal>
  </div>;
}
