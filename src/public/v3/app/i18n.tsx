import { createContext, type ComponentChildren } from 'preact';
import { useContext, useMemo, useState } from 'preact/hooks';
import type { Locale } from '../model.js';

const STORAGE_KEY = 'anoclaw.v3.locale';

const zhCN = {
  'brand.name': 'AnoClaw 3.0',
  'common.skip': '跳到主要内容',
  'nav.work': '工作',
  'nav.primary': '主要导航',
  'nav.company': '公司',
  'nav.settings': '设置',
  'nav.recent': '最近的工作',
  'nav.noRecent': '还没有工作',
  'chrome.minimize': '最小化',
  'chrome.controls': '窗口控制',
  'chrome.maximize': '最大化',
  'chrome.close': '关闭',
  'status.localReady': '本地运行正常',
  'status.localOnly': '数据存储：本地加密',
  'status.connecting': '正在连接本地服务',
  'status.unavailable': '本地服务暂不可用',
  'work.workspace': '工作区',
  'work.running': '运行中',
  'work.paused': '已暂停',
  'work.completed': '已完成',
  'work.draft': '草稿',
  'work.stop': '暂停工作',
  'work.resume': '继续工作',
  'work.objective': '工作目标',
  'work.progress': '执行摘要',
  'work.noPlan': 'MainAgent 尚未拆解这项工作的执行阶段。',
  'work.tellAgent': '告诉 MainAgent 你的目标或问题…',
  'work.noSession': '这项工作尚未创建 MainAgent 会话',
  'work.send': '发送',
  'work.you': '你',
  'work.mainAgent': 'MainAgent',
  'work.emptyTitle': '创建第一项工作',
  'work.emptyBody': '给 MainAgent 一个清晰目标。所有工作内容都只保存在这台电脑上。',
  'work.titleLabel': '工作标题',
  'work.objectiveLabel': '目标与验收标准',
  'work.create': '开始工作',
  'work.creating': '正在创建…',
  'work.workspaceChoice': '这项工作需要使用项目文件吗？',
  'work.oneOffTitle': '一次性工作',
  'work.oneOffBody': '不绑定文件夹，适合问答、分析与临时事项',
  'work.projectTitle': '项目工作',
  'work.projectBody': '绑定本地文件夹，便于持续读写与长期推进',
  'work.existingWorkspace': '已有项目文件夹',
  'work.chooseWorkspace': '选择一个工作区',
  'work.projectRequired': '选择文件夹后即可开始这项项目工作。',
  'work.noMessages': '向 MainAgent 说明你想完成什么，这里会保留完整工作记录。',
  'session.show': '会话记录',
  'session.transparency': '透明协作',
  'session.title': '员工会话树',
  'session.subtitle': '查看 MainAgent 如何把工作交给团队；员工会话仅供查看。',
  'session.runCount': '{count} 个执行会话',
  'session.close': '收起会话树',
  'session.none': '这项工作还没有创建会话。',
  'session.primaryBadge': '主会话',
  'session.mainConversation': '你与 MainAgent 的工作对话',
  'session.unlinkedRun': '团队执行会话',
  'session.active': '进行中',
  'session.idle': '空闲',
  'session.closed': '已结束',
  'session.readOnly': '只读员工会话',
  'session.backToMain': '返回 MainAgent',
  'session.runConversation': '员工执行对话',
  'session.noTranscript': '这个员工会话还没有可显示的记录。',
  'session.assignment': '任务上下文',
  'session.tool': '工具',
  'session.system': '系统',
  'session.composerMainOnly': '输入内容始终发送给 MainAgent，不会直接打断员工。',
  'bootstrap.title': '建立你的本地 AI 公司',
  'bootstrap.body': '只需一个公司名称即可开始。不会创建账户，也不会把数据上传到云端。',
  'bootstrap.name': '公司名称',
  'bootstrap.description': '公司简介（可选）',
  'bootstrap.create': '创建本地公司',
  'bootstrap.creating': '正在建立…',
  'activity.title': '公司动态',
  'activity.empty': '代理开始工作后，关键进展会出现在这里。',
  'activity.created': '创建了',
  'activity.updated': '更新了',
  'activity.completed': '完成了',
  'activity.reported': '提交了',
  'activity.started': '开始处理',
  'activity.item': '一项工作',
  'activity.deliverables': '关键交付',
  'activity.noDeliverables': '完成的任务和报告会显示在这里。',
  'activity.viewWork': '查看工作',
  'floor.title': '公司楼层',
  'floor.collapse': '折叠公司楼层',
  'floor.expand': '展开公司楼层',
  'floor.unassigned': '直属代理',
  'floor.empty': '创建代理和团队后，公司楼层会显示实时协作关系。',
  'floor.insightHandoff': '洞察汇总',
  'floor.strategyHandoff': '策略方案',
  'company.title': '公司',
  'company.subtitle': '你的本地组织、团队与代理',
  'company.teams': '团队',
  'company.agents': '代理',
  'company.workspaces': '工作区',
  'company.noTeams': '尚未创建团队',
  'company.noAgents': '尚未创建代理',
  'company.noWorkspaces': '尚未绑定工作区',
  'company.workspacesHelp': '项目文件夹可被多项工作持续使用；文件始终留在本机。',
  'company.active': '活跃',
  'company.paused': '暂停',
  'workspace.add': '添加文件夹',
  'workspace.adding': '正在添加…',
  'workspace.chooseFolder': '选择新的项目文件夹',
  'workspace.pickerTitle': '选择 AnoClaw 项目文件夹',
  'workspace.pickerConfirm': '使用此文件夹',
  'workspace.pickerUnavailable': '请在 AnoClaw 桌面应用中选择本地文件夹。',
  'settings.title': '设置',
  'settings.subtitle': 'AnoClaw 的界面偏好仅保存在本机',
  'settings.language': '界面语言',
  'settings.languageHelp': '立即切换界面与公司默认工作语言；既有用户内容和代理内容保持原样。',
  'settings.layout': '工作布局',
  'settings.layoutHelp': '简洁模式聚焦 MainAgent；专业模式同时显示公司动态和公司楼层。',
  'settings.simple': '简洁',
  'settings.professional': '专业',
  'settings.zh': '简体中文',
  'settings.en': 'English',
  'settings.storage': '本地优先',
  'settings.storageHelp': 'AnoClaw 3.0 不需要登录；公司数据与工作记录保存在这台电脑上。',
  'common.loading': '正在读取本地公司…',
  'common.retry': '重试',
  'common.error': '无法读取 AnoClaw 3.0 数据',
  'common.noDescription': '没有描述',
  'common.justNow': '刚刚',
  'common.unknownAgent': '代理',
  'error.notFound': '请求的数据不存在，界面已尝试重新同步。',
  'error.revisionConflict': '数据已经被其他操作更新，请重试。',
  'error.invalidResponse': '本地服务返回了无法识别的数据。',
  'error.validation': '提交内容不符合当前工作状态要求。',
  'error.unavailable': '本地服务暂时不可用，请稍后重试。',
  'error.unknown': '操作未完成，请重试。',
  'verification.userRequired': '等待你的验收',
  'verification.approve': '通过验收',
  'verification.requestRevision': '要求修改',
  'verification.approvedSummary': '用户确认任务已满足验收标准。',
  'verification.revisionSummary': '用户要求团队根据验收标准继续修改。',
  'verification.userEvidence': '用户在工作界面完成验收',
  'stage.completed': '已完成',
  'stage.active': '进行中',
  'stage.blocked': '受阻',
  'stage.planned': '待执行',
} as const;

export type MessageKey = keyof typeof zhCN;
type Messages = Record<MessageKey, string>;

const enUS: Messages = {
  'brand.name': 'AnoClaw 3.0',
  'common.skip': 'Skip to content',
  'nav.work': 'Work',
  'nav.primary': 'Primary navigation',
  'nav.company': 'Company',
  'nav.settings': 'Settings',
  'nav.recent': 'Recent work',
  'nav.noRecent': 'No work yet',
  'chrome.minimize': 'Minimize',
  'chrome.controls': 'Window controls',
  'chrome.maximize': 'Maximize',
  'chrome.close': 'Close',
  'status.localReady': 'Local runtime healthy',
  'status.localOnly': 'Storage: local & encrypted',
  'status.connecting': 'Connecting to local service',
  'status.unavailable': 'Local service unavailable',
  'work.workspace': 'Workspace',
  'work.running': 'Running',
  'work.paused': 'Paused',
  'work.completed': 'Completed',
  'work.draft': 'Draft',
  'work.stop': 'Pause work',
  'work.resume': 'Resume work',
  'work.objective': 'Objective',
  'work.progress': 'Execution summary',
  'work.noPlan': 'MainAgent has not broken this work into execution stages yet.',
  'work.tellAgent': 'Tell MainAgent your goal or question…',
  'work.noSession': 'This work does not have a MainAgent session yet',
  'work.send': 'Send',
  'work.you': 'You',
  'work.mainAgent': 'MainAgent',
  'work.emptyTitle': 'Create your first work',
  'work.emptyBody': 'Give MainAgent a clear outcome. Everything stays on this computer.',
  'work.titleLabel': 'Work title',
  'work.objectiveLabel': 'Objective and acceptance criteria',
  'work.create': 'Start work',
  'work.creating': 'Creating…',
  'work.workspaceChoice': 'Will this work use project files?',
  'work.oneOffTitle': 'One-off work',
  'work.oneOffBody': 'No folder. Best for questions, analysis, and quick requests',
  'work.projectTitle': 'Project work',
  'work.projectBody': 'Connect a local folder for ongoing reading, writing, and progress',
  'work.existingWorkspace': 'Existing project folder',
  'work.chooseWorkspace': 'Choose a workspace',
  'work.projectRequired': 'Choose a folder before starting this project work.',
  'work.noMessages': 'Tell MainAgent what you want to accomplish. The full work record stays here.',
  'session.show': 'Session history',
  'session.transparency': 'Transparent collaboration',
  'session.title': 'Employee session tree',
  'session.subtitle': 'See how MainAgent delegates work across the team. Employee sessions are view-only.',
  'session.runCount': '{count} run sessions',
  'session.close': 'Collapse session tree',
  'session.none': 'No sessions have been created for this work yet.',
  'session.primaryBadge': 'Primary',
  'session.mainConversation': 'Your work conversation with MainAgent',
  'session.unlinkedRun': 'Team execution session',
  'session.active': 'Running',
  'session.idle': 'Idle',
  'session.closed': 'Closed',
  'session.readOnly': 'Read-only employee session',
  'session.backToMain': 'Back to MainAgent',
  'session.runConversation': 'Employee execution conversation',
  'session.noTranscript': 'This employee session does not have a visible transcript yet.',
  'session.assignment': 'Task context',
  'session.tool': 'Tool',
  'session.system': 'System',
  'session.composerMainOnly': 'Messages always go to MainAgent and never interrupt an employee directly.',
  'bootstrap.title': 'Build your local AI company',
  'bootstrap.body': 'Start with a company name. No account is created and no data is uploaded.',
  'bootstrap.name': 'Company name',
  'bootstrap.description': 'Company description (optional)',
  'bootstrap.create': 'Create local company',
  'bootstrap.creating': 'Creating…',
  'activity.title': 'Company activity',
  'activity.empty': 'Key progress will appear here as agents begin working.',
  'activity.created': 'created',
  'activity.updated': 'updated',
  'activity.completed': 'completed',
  'activity.reported': 'submitted',
  'activity.started': 'started',
  'activity.item': 'a work item',
  'activity.deliverables': 'Key deliverables',
  'activity.noDeliverables': 'Completed tasks and reports will appear here.',
  'activity.viewWork': 'View work',
  'floor.title': 'Company floor',
  'floor.collapse': 'Collapse company floor',
  'floor.expand': 'Expand company floor',
  'floor.unassigned': 'Direct reports',
  'floor.empty': 'Create agents and teams to see live collaboration here.',
  'floor.insightHandoff': 'Insight handoff',
  'floor.strategyHandoff': 'Strategy handoff',
  'company.title': 'Company',
  'company.subtitle': 'Your local organization, teams, and agents',
  'company.teams': 'Teams',
  'company.agents': 'Agents',
  'company.workspaces': 'Workspaces',
  'company.noTeams': 'No teams yet',
  'company.noAgents': 'No agents yet',
  'company.noWorkspaces': 'No workspaces connected',
  'company.workspacesHelp': 'Project folders can support many Works over time. Files always stay local.',
  'company.active': 'Active',
  'company.paused': 'Paused',
  'workspace.add': 'Add folder',
  'workspace.adding': 'Adding…',
  'workspace.chooseFolder': 'Choose a new project folder',
  'workspace.pickerTitle': 'Choose an AnoClaw project folder',
  'workspace.pickerConfirm': 'Use this folder',
  'workspace.pickerUnavailable': 'Choose local folders from the AnoClaw desktop app.',
  'settings.title': 'Settings',
  'settings.subtitle': 'AnoClaw interface preferences stay on this computer',
  'settings.language': 'Interface language',
  'settings.languageHelp': 'Switch the interface and the company default working language instantly. Existing content stays unchanged.',
  'settings.layout': 'Work layout',
  'settings.layoutHelp': 'Simple mode focuses MainAgent. Professional mode also shows activity and the company floor.',
  'settings.simple': 'Simple',
  'settings.professional': 'Professional',
  'settings.zh': '简体中文',
  'settings.en': 'English',
  'settings.storage': 'Local first',
  'settings.storageHelp': 'AnoClaw 3.0 needs no sign-in. Company data and work records remain on this PC.',
  'common.loading': 'Reading your local company…',
  'common.retry': 'Retry',
  'common.error': 'Unable to read AnoClaw 3.0 data',
  'common.noDescription': 'No description',
  'common.justNow': 'Just now',
  'common.unknownAgent': 'Agent',
  'error.notFound': 'The requested data no longer exists. The view has tried to resync.',
  'error.revisionConflict': 'The data changed in another operation. Please try again.',
  'error.invalidResponse': 'The local service returned data AnoClaw could not understand.',
  'error.validation': 'The request is not valid for the current Work state.',
  'error.unavailable': 'The local service is temporarily unavailable. Please try again.',
  'error.unknown': 'The operation did not finish. Please try again.',
  'verification.userRequired': 'Waiting for your review',
  'verification.approve': 'Approve',
  'verification.requestRevision': 'Request changes',
  'verification.approvedSummary': 'The user confirmed that the task meets its acceptance criteria.',
  'verification.revisionSummary': 'The user asked the team to revise the task against its acceptance criteria.',
  'verification.userEvidence': 'User review completed in the Work interface',
  'stage.completed': 'Completed',
  'stage.active': 'In progress',
  'stage.blocked': 'Blocked',
  'stage.planned': 'Planned',
};

const messages: Record<Locale, Messages> = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
  formatTime: (value: string) => string;
  formatDate: (value: string) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ children }: { children: ComponentChildren }) {
  const [locale, setLocaleState] = useState<Locale>(readLocale);
  const value = useMemo<I18nValue>(() => ({
    locale,
    setLocale(next) {
      setLocaleState(next);
      document.documentElement.lang = next;
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // The selected locale still applies for this run if storage is unavailable.
      }
    },
    t: (key) => messages[locale][key],
    formatTime: (value) => {
      const date = new Date(value);
      return Number.isNaN(date.valueOf())
        ? value
        : new Intl.DateTimeFormat(locale, {
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(date);
    },
    formatDate: (value) => {
      const date = new Date(value);
      return Number.isNaN(date.valueOf())
        ? value
        : new Intl.DateTimeFormat(locale, {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(date);
    },
  }), [locale]);

  document.documentElement.lang = locale;
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error('useI18n must be used inside I18nProvider');
  return value;
}

export function errorMessageKey(error: Error): MessageKey {
  const code = 'code' in error && typeof error.code === 'string'
    ? error.code.toLowerCase()
    : '';
  const status = 'status' in error && typeof error.status === 'number'
    ? error.status
    : 0;
  if (status === 404 || code.includes('not_found')) return 'error.notFound';
  if (status === 409 || code.includes('revision') || code.includes('conflict')) {
    return 'error.revisionConflict';
  }
  if (status === 422 || code.includes('invalid') || code.includes('validation')) {
    return code.includes('response') ? 'error.invalidResponse' : 'error.validation';
  }
  if (status >= 500 || status === 0) return 'error.unavailable';
  return 'error.unknown';
}

function readLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'zh-CN' || saved === 'en-US') return saved;
  } catch {
    // Fall through to the operating-system preference.
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US';
}
