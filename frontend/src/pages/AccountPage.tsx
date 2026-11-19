import React, { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, Eye, EyeOff, FileJson, KeyRound, LogIn, LogOut, MapPin, MessageCircle, RefreshCw, ShieldCheck, UserRound, Watch } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api, post } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, Modal, PageHeader, Select, toast } from '../components/ui';
import { formatTime } from './HomePageParts';
import './account-md3.css';

const VERIFY_MODES: Record<string, string> = { 1: '旧设备验证', 2: '家庭成员验证', 3: '短信验证码', 4: '密保问题', 6: '其它方式' };

export default function AccountPage() {
  const { navigate, refreshAll, tokenInvalid } = useApp();
  const resource = useResource((signal: AbortSignal) => api('/api/account', { signal }), []);
  const account: any = { ...resource.data, loggedIn: !!resource.data?.loggedIn && !tokenInvalid && !resource.data?.sessionExpired };
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState('');
  const [loginError, setLoginError] = useState('');
  const [challenge, setChallenge] = useState<any>(null);
  const [questions, setQuestions] = useState<any[]>([]);
  const [questionId, setQuestionId] = useState('');
  const [answer, setAnswer] = useState('');
  const [verifyError, setVerifyError] = useState('');
  const [verifyTip, setVerifyTip] = useState('');
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configuration, setConfiguration] = useState<any>(null);
  const [configError, setConfigError] = useState('');
  const passwordId = useId();
  const loginErrorId = useId();
  const verificationCredentials = useRef({ account: '', password: '' });
  const verificationRequest = useRef(0);
  const mounted = useRef(true);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; verificationCredentials.current = { account: '', password: '' }; }; }, []);
  useEffect(() => { if (account.userName) setUserName(account.userName); }, [account.userName]);

  function clearChallenge() {
    verificationRequest.current++;
    setChallenge(null); setQuestions([]); setQuestionId(''); setAnswer(''); setVerifyError('');
    setBusy(current => current === 'questions' ? '' : current);
    verificationCredentials.current = { account: '', password: '' };
  }

  async function loginComplete() {
    clearChallenge(); setPassword(''); setLoginError('');
    toast('登录成功');
    await resource.reload();
    try { await refreshAll(); } catch { toast('已登录，手表列表暂未刷新，请稍后重试。', 'warning'); }
  }

  async function loadQuestions(nextChallenge: any, name: string) {
    const requestId = ++verificationRequest.current;
    setBusy('questions'); setVerifyError('');
    try {
      const result: any = await post('/api/account/verify/questions', { account: name, checkCode: nextChallenge.checkCode });
      if (!mounted.current || requestId !== verificationRequest.current) return;
      const list = Array.isArray(result.questions) ? result.questions : [];
      setQuestions(list);
      setQuestionId(String((list.find((q: any) => /天才号/.test(q.question || '')) || list[0])?.questionId ?? ''));
      setVerifyTip(result.tip || '');
      if (!list.length) setVerifyError('没有可用的密保问题，请稍后重试。');
    } catch (error: any) { if (mounted.current && requestId === verificationRequest.current) setVerifyError(error.message); }
    finally { if (mounted.current && requestId === verificationRequest.current) setBusy(''); }
  }

  async function login(event: React.FormEvent) {
    event.preventDefault();
    const name = userName.trim();
    if (!name || !password) { setLoginError('请输入账号和密码。'); return; }
    setBusy('login'); setLoginError('');
    try {
      const result: any = await post('/api/account/login', { account: name, password });
      if (!mounted.current) return;
      if (result?.needVerify) {
        const nextChallenge = result.challenge || {};
        verificationCredentials.current = { account: name, password };
        setChallenge(nextChallenge); setAnswer(''); setQuestions([]);
        await loadQuestions(nextChallenge, name);
        return;
      }
      await loginComplete();
    } catch (error: any) { if (mounted.current) setLoginError(error.message); }
    finally { if (mounted.current) setBusy(''); }
  }

  async function verify(event: React.FormEvent) {
    event.preventDefault();
    if (!questionId || !answer.trim()) { setVerifyError('请选择密保问题并填写答案。'); return; }
    setBusy('verify'); setVerifyError('');
    try {
      await post('/api/account/verify/question', {
        ...verificationCredentials.current, checkCode: challenge.checkCode, questionId, answer: answer.trim(),
      });
      if (mounted.current) await loginComplete();
    } catch (error: any) { if (mounted.current) setVerifyError(error.message); }
    finally { if (mounted.current) setBusy(''); }
  }

  async function logout() {
    setBusy('logout'); setLoginError('');
    try {
      await post('/api/account/logout');
      setLogoutOpen(false); setPassword(''); clearChallenge();
      toast('已退出家长账号');
      await resource.reload();
      await refreshAll();
    } catch (error: any) { setLoginError(error.message); toast(error.message, 'danger'); }
    finally { setBusy(''); }
  }

  async function showConfig() {
    setConfigOpen(true); setConfiguration(null); setConfigError(''); setBusy('config');
    try { const result: any = await api('/api/config'); if (mounted.current) setConfiguration(result.config); }
    catch (error: any) { if (mounted.current) setConfigError(error.message); }
    finally { if (mounted.current) setBusy(''); }
  }

  const selectedQuestion = questions.find(q => String(q.questionId) === questionId);
  const checkNames = (challenge?.checkTypes || []).map((value: any) => VERIFY_MODES[value] || `方式 ${value}`);

  const benefits = [
    { title: '同步手表', description: '查看账号下已经绑定的手表。', icon: Watch },
    { title: '保持联系', description: '收发手表和家庭群消息。', icon: MessageCircle },
    { title: '安心守护', description: '查看位置，管理联系人与设备设置。', icon: MapPin },
  ];

  return <div className="stack account-page">
    <PageHeader title="家长账号" description="管理家长端登录，同步手表与家庭会话。" actions={<Button variant="secondary" onClick={resource.reload} disabled={resource.loading || !!busy} aria-busy={resource.loading}><RefreshCw size={19} className={resource.loading ? 'spin' : ''} aria-hidden="true" />刷新</Button>} />
    {(tokenInvalid || resource.data?.sessionExpired) && <div className="inline-notice" role="alert"><ShieldCheck size={19} aria-hidden="true" /><span>家长账号登录已失效，请重新登录。填写下方账号和密码即可恢复。</span></div>}
    {resource.loading && !resource.data && <LoadingState />}
    {resource.error && !resource.data && <ErrorState error={resource.error} onRetry={resource.reload} />}
    {resource.error && resource.data && <div className="inline-notice" role="status"><RefreshCw size={19} aria-hidden="true" /><span>账号信息暂未更新，正在显示上次读取的状态。</span><Button variant="ghost" onClick={resource.reload} disabled={resource.loading || !!busy}>重试</Button></div>}
    {(!resource.loading || resource.data) && <div className="account-layout" data-logged-in={!!account.loggedIn}>
      <Card className="account-summary" aria-label={account.loggedIn ? '当前家长账号' : '家长账号说明'}>
        <div className="account-summary-heading">
          <span className="account-identity-icon" aria-hidden="true"><UserRound size={30} strokeWidth={1.6} /></span>
          <Badge tone={account.loggedIn ? 'success' : 'neutral'}>{account.loggedIn ? <Check size={15} aria-hidden="true" /> : undefined}{account.loggedIn ? '已登录' : '未登录'}</Badge>
        </div>
        <div className="account-identity-copy"><h2>{account.loggedIn ? account.userName || '当前账号' : '连接你的家长账号'}</h2><p>{account.loggedIn ? '手表和家庭会话会从当前账号同步。' : '使用官方家长端的账号和密码登录，在这里管理手表、收发消息和查看位置。'}</p></div>
          {account.loggedIn ? <>
            <dl className="account-identifiers">
              <div><dt>账号</dt><dd>{account.userName || '—'}</dd></div>
              <div><dt>authId</dt><dd className="mono">{account.authId || '—'}</dd></div>
              <div><dt>mobileId</dt><dd className="mono">{account.mobileId || '—'}</dd></div>
            </dl>
            <div className="account-management-actions"><Button variant="secondary" onClick={showConfig} disabled={!!busy}><FileJson size={19} aria-hidden="true" />查看配置</Button><Button variant="danger" onClick={() => setLogoutOpen(true)} disabled={!!busy}><LogOut size={19} aria-hidden="true" />退出登录</Button></div>
            <Button variant="ghost" className="account-home-link" onClick={() => navigate('home')}>返回主页<ArrowRight size={18} aria-hidden="true" /></Button>
          </> : <ul className="account-benefits">
            {benefits.map(item => <li key={item.title}><span aria-hidden="true"><item.icon size={23} strokeWidth={1.7} /></span><div><strong>{item.title}</strong><p>{item.description}</p></div></li>)}
          </ul>}
      </Card>
      <Card className="account-login-card" title={account.loggedIn ? '切换账号' : '账号登录'} description={account.loggedIn ? '登录另一个账号后，将同步该账号的手表。' : '请输入手机号或家长账号。'}>
        <form className="account-login-form" onSubmit={login}>
          <Field label="手机号 / 账号"><Input value={userName} onChange={event => setUserName(event.target.value)} autoComplete="username" placeholder="输入你的家长账号" required disabled={!!busy} aria-invalid={!!loginError} aria-describedby={loginError ? loginErrorId : undefined} /></Field>
          <div className="field"><label className="field-label" htmlFor={passwordId}>密码</label><div className="account-password"><Input id={passwordId} value={password} type={showPassword ? 'text' : 'password'} onChange={event => setPassword(event.target.value)} autoComplete="current-password" placeholder="输入账号密码" required disabled={!!busy} aria-invalid={!!loginError} aria-describedby={loginError ? loginErrorId : undefined} /><button type="button" className="account-password-visibility" onClick={() => setShowPassword(value => !value)} aria-label={showPassword ? '隐藏密码' : '显示密码'}>{showPassword ? <EyeOff size={21} aria-hidden="true" /> : <Eye size={21} aria-hidden="true" />}</button></div></div>
          {loginError && <p role="alert" id={loginErrorId} className="account-form-error">{loginError}</p>}
          <Button type="submit" loading={busy === 'login'} disabled={!!busy} className="account-submit">{busy !== 'login' && <LogIn size={20} aria-hidden="true" />}{busy === 'login' ? '正在登录…' : account.loggedIn ? '登录并切换账号' : '登录家长账号'}</Button>
          <div className="account-login-note"><ShieldCheck size={21} strokeWidth={1.7} aria-hidden="true" /><p>首次在新设备登录时，可能需要回答账号的密保问题。验证通过后即可管理手表。</p></div>
        </form>
      </Card>
    </div>}

    <Modal open={!!challenge} onClose={() => { if (busy !== 'verify') clearChallenge(); }} closeable={busy !== 'verify'} title="新设备安全验证" description={`账号 ${verificationCredentials.current.account} 需要完成验证后才能登录。`} className="account-verification-dialog">
      <form className="account-verification-form" onSubmit={verify}>
        <span className="account-verification-icon" aria-hidden="true"><KeyRound size={26} strokeWidth={1.7} /></span>
        {checkNames.length > 0 && <p className="account-verification-note">账号支持的方式：{checkNames.join(' / ')}。当前使用密保问题验证。</p>}
        {verifyTip && <p className="account-verification-note">{verifyTip}</p>}
        {busy === 'questions' ? <LoadingState text="正在获取密保问题…" /> : <>
          <Field label="密保问题"><Select value={questionId} onChange={event => { setQuestionId(event.target.value); setAnswer(''); }} disabled={!questions.length || busy === 'verify'}>{questions.length ? questions.map(q => <option key={q.questionId} value={String(q.questionId)}>{q.question}</option>) : <option value="">暂无可用问题</option>}</Select></Field>
          <Field label={selectedQuestion?.content || '答案'}><Input value={answer} onChange={event => setAnswer(event.target.value)} placeholder="请输入密保答案" autoComplete="off" disabled={!questions.length || busy === 'verify'} required /></Field>
        </>}
        {!!challenge?.endTime && <p className="account-verification-note">验证有效期至 {formatTime(challenge.endTime)}</p>}
        {verifyError && <p role="alert" className="account-form-error">{verifyError}</p>}
        {!questions.length && busy !== 'questions' && <Button variant="secondary" type="button" onClick={() => loadQuestions(challenge, verificationCredentials.current.account)}><RefreshCw size={19} aria-hidden="true" />重新获取问题</Button>}
        <div className="account-modal-actions"><Button variant="secondary" type="button" onClick={clearChallenge} disabled={busy === 'verify'}>取消</Button><Button type="submit" loading={busy === 'verify'} disabled={!questions.length || !!busy}>{busy === 'verify' ? '正在验证…' : '验证并登录'}</Button></div>
      </form>
    </Modal>

    <Modal open={logoutOpen} onClose={() => { if (busy !== 'logout') setLogoutOpen(false); }} closeable={busy !== 'logout'} title="退出家长账号？" description="退出后，将断开当前账号的 IM 连接并清空当前会话记录。" footer={<><Button variant="secondary" onClick={() => setLogoutOpen(false)} disabled={busy === 'logout'}>取消</Button><Button variant="danger" onClick={logout} loading={busy === 'logout'} disabled={busy === 'logout'}>{busy === 'logout' ? '正在退出…' : '确认退出'}</Button></>}>
      <p className="muted">之后可以重新登录这个账号，或切换到其他家长账号。</p>
    </Modal>
    <Modal open={configOpen} onClose={() => { setConfigOpen(false); setConfiguration(null); }} title="当前配置" description="服务端返回的配置快照。" size="lg" className="account-config-dialog">
      {busy === 'config' ? <LoadingState text="正在读取配置…" /> : configError ? <ErrorState error={configError} onRetry={showConfig} /> : <pre className="mono account-config-snapshot" tabIndex={0} aria-label="当前服务配置 JSON">{JSON.stringify(configuration, null, 2)}</pre>}
    </Modal>
  </div>;
}
