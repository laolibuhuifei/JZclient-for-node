import { Activity, AlarmClock, AppWindow, ArrowRight, Baby, Bot, ClipboardList, Contact, Link, Settings2, ShieldCheck, SlidersHorizontal, UsersRound, Watch, Wifi } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { api } from '../lib/api';
import { useResource } from '../lib/hooks';
import { Badge, Button, Card, PageHeader } from '../components/ui';
import '../components/device/device.css';

const groups = [
  { title: '设备', description: '了解和管理孩子的手表', entries: [
    ['overview', '设备概览', '状态、资料与常用操作', Watch], ['profile', '宝贝资料', '记录孩子的成长信息', Baby], ['health', '健康数据', '运动、睡眠与心率', Activity], ['wifi', 'Wi-Fi', '已保存的网络与状态', Wifi], ['apps', '应用管理', '应用列表与使用限制', AppWindow], ['alarms', '闹钟', '按每天的节奏提醒', AlarmClock],
  ] },
  { title: '通讯', description: '让每次联系更简单', entries: [['friends', '手表好友', '好友列表与加好友口令', UsersRound], ['contacts', '通讯录', '管理家人和常用联系人', Contact]] },
  { title: '安全与系统', description: '按孩子的需要设置', entries: [['guard', '安全区域', '守护范围与危险区域', ShieldCheck], ['settings', '设备设置', '声音、时段与隐私', Settings2], ['hidden', '高级信息', '系统状态与扩展信息', SlidersHorizontal], ['ai', 'AI 助手', '自动回复与识图', Bot], ['bind', '绑定手表', '添加或迁移一块手表', Link]] },
] as const;
const modules: Record<string, number[][]> = { health: [[2642]], wifi: [[2513]], ai: [[3886]], apps: [[72, 3171]] };
export function featureState(capabilities: any, page: string): 'available' | 'hidden' | 'disabled' {
  const map = capabilities?.modules || {};
  for (const ids of modules[page] || []) {
    const found = ids.map(id => map[id]).filter(item => item?.display != null);
    if (found.length < ids.length || found.some(item => Number(item.display) === 0)) continue;
    if (found.some(item => Number(item.display) === 2)) return 'disabled';
    return 'hidden';
  }
  return 'available';
}
export default function FeaturesPage() {
  const { watch, watchId, navigate, account } = useApp();
  const { data } = useResource(() => watchId ? api(`/api/watch/${encodeURIComponent(watchId)}/capabilities`) : Promise.resolve(null), [watchId]);
  return <div className="features-page stack">
    <PageHeader title="全部功能" description="设备管理、日常联系与安全设置。" actions={<Button onClick={() => navigate('bind')}><Link size={19} />绑定手表</Button>} />
    <div className="features-layout">
      <div className="stack feature-groups">{groups.map(group => {
        const entries = group.entries.filter(([page]) => featureState(data, page) !== 'hidden');
        return <Card key={group.title} className="feature-group" title={group.title} description={group.description} action={<Badge>{entries.length} 项</Badge>}>
          <div className="feature-grid">{entries.map(([page, label, description, Icon]) => {
            const disabled = featureState(data, page) === 'disabled';
            return <button type="button" key={page} className="feature-entry" disabled={disabled} onClick={() => navigate(page)}>
              <span className="feature-symbol" aria-hidden="true"><Icon size={23} strokeWidth={1.7} /></span>
              <span><strong>{label}</strong><small>{disabled ? '此型号暂不可用' : description}</small></span>
              <ArrowRight size={18} className="feature-arrow" aria-hidden="true" />
            </button>;
          })}</div>
        </Card>;
      })}</div>
      <aside className="stack features-aside" aria-label="当前设备信息">
        <Card className="feature-device-card" title="当前手表" action={<span className="device-section-icon" aria-hidden="true"><Watch size={22} strokeWidth={1.7} /></span>}>
          <div className="feature-device-heading">
            <h3>{watch?.name || '还没有选择手表'}</h3>
            <p>{watch?.model || '绑定后即可使用设备功能'}</p>
            {watch && <Badge tone={watch.onlineStatus === true ? 'success' : 'neutral'}>{watch.onlineStatus === true ? '在线' : watch.onlineStatus === false ? '离线' : '状态未知'}</Badge>}
          </div>
          <dl className="device-data-rows">
            <div><dt>设备 ID</dt><dd className="mono">{watch?.watchId || '—'}</dd></div>
            <div><dt>手表号码</dt><dd>{watch?.number || '—'}</dd></div>
            <div><dt>固件版本</dt><dd>{watch?.firmware || '—'}</dd></div>
          </dl>
          <Button variant="secondary" className="full-width" onClick={() => navigate(!account.loggedIn ? 'account' : watchId ? 'overview' : 'bind')}>
            {!account.loggedIn ? '登录家长账号' : watchId ? '查看设备详情' : '绑定手表'}<ArrowRight size={18} aria-hidden="true" />
          </Button>
        </Card>
        <div className="feature-capability-note"><ClipboardList size={22} aria-hidden="true" /><div><h3>功能随设备更新</h3><p>切换手表后，按型号和系统版本显示可用功能。</p></div></div>
      </aside>
    </div>
  </div>;
}
