const LANGUAGE_MODES = new Set(['default', 'zh-CN']);

const EXACT_TRANSLATIONS = new Map([
    ['Settings', '设置'],
    ['New Agent', '新建 Agent'],
    ['Automations', '自动化'],
    ['Create an Automation', '创建自动化'],
    ['Save time by automating repetitive tasks with always-on agents that respond to triggers.', '使用可持续运行并响应触发器的 agents 自动化重复任务，节省时间。'],
    ['Popular', '热门'],
    ['Code Review', '代码审查'],
    ['Incidents & Triage', '事故与分诊'],
    ['Data & Research', '数据与研究'],
    ['Find bugs', '查找 bug'],
    ['Find critical bugs', '查找关键 bug'],
    ['Analyze recent commits for high-severity correctness bugs and submit safe fixes', '分析最近的提交，找出高严重性的正确性 bug，并提交安全修复。'],
    ['Find vulnerabilities', '查找漏洞'],
    ['Review pull requests for exploitable security issues and flag only validated findings before merge', '在合并前审查 pull requests 中可被利用的安全问题，并且只标记已验证的发现。'],
    ['Assign PR reviewers', '分配 PR 审查者'],
    ['Assign reviewers based on code changes and auto-approve low-risk PRs', '根据代码变更分配审查者，并自动批准低风险 PR。'],
    ['Monitor engineering invariants', '监控工程不变量'],
    ['Re-check critical repository invariants on a schedule and alert only when a rule regresses', '按计划重新检查仓库中的关键不变量，并且仅在规则退化时发出提醒。'],
    ['Remediate dependency vulnerabilities', '修复依赖漏洞'],
    ['Triage dependency-vulnerability tickets from Linear and open upgrade PRs when the fix is safe', '分诊来自 Linear 的依赖漏洞工单，并在修复安全时创建升级 PR。'],
    ['Scan codebase for vulnerabilities', '扫描代码库中的漏洞'],
    ['Review the full repository on a schedule and alert on validated high-impact security issues', '按计划审查整个仓库，并对已验证的高影响安全问题发出提醒。'],
    ['Generate docs', '生成文档'],
    ['Create and update developer documentation for recently changed or under-documented code', '为最近变更或文档不足的代码创建并更新开发者文档。'],
    ['Add test coverage', '补充测试覆盖'],
    ['Review recent changes and add tests for high-risk logic that lacks adequate coverage', '审查最近的变更，并为缺少充分覆盖的高风险逻辑补充测试。'],
    ['Fix bugs reported in Slack', '修复 Slack 中报告的 bug'],
    ['Monitor a Slack channel for bug reports, investigate the codebase, and fix with a PR', '监控 Slack 频道中的 bug 报告，调查代码库，并通过 PR 进行修复。'],
    ['Fix CI failures', '修复 CI 失败'],
    ['Detect CI failures on main and automatically open PRs', '检测 main 分支上的 CI 失败并自动创建 PR。'],
    ['Investigate PagerDuty incidents', '调查 PagerDuty 事故'],
    ['Investigate incidents using Datadog and code context', '结合 Datadog 和代码上下文调查事故。'],
    ['Investigate Sentry issues', '调查 Sentry 问题'],
    ['Investigate errors from Sentry, identify root causes, and propose fixes', '调查来自 Sentry 的错误，找出根因，并提出修复方案。'],
    ['Investigate top Datadog errors', '调查 Datadog 高发错误'],
    ['Investigate recurring production errors from Datadog, identify root causes, and propose fixes', '调查 Datadog 中反复出现的生产错误，找出根因，并提出修复方案。'],
    ['Triage Linear issues', '分诊 Linear 问题'],
    ['Triage new issues by investigating bugs, planning feature requests, and opening PRs for easy fixes', '通过调查 bug、规划功能请求，以及为简单修复创建 PR 来分诊新问题。'],
    ['Summarize changes daily', '每日汇总变更'],
    ['Post a daily Slack digest summarizing notable repository changes and risks from the previous day', '每天在 Slack 发布摘要，总结前一天仓库中的重要变更和风险。'],
    ['Customer Health Monitoring Agent', '客户健康监控 Agent'],
    ['Find at-risk customers using usage analytics, call notes, Slack escalations, and Linear blockers', '结合用量分析、通话记录、Slack 升级和 Linear 阻塞项来识别有流失风险的客户。'],
    ['Product Analytics Agent', '产品分析 Agent'],
    ['Weekly product usage, activation, retention, and feature adoption digest from Databricks', '来自 Databricks 的每周产品用量、激活、留存和功能采用摘要。'],
    ['Product FAQ Agent', '产品 FAQ Agent'],
    ['Answer product questions in a dedicated Slack channel using Slack, Notion, Linear, and GitHub context', '结合 Slack、Notion、Linear 和 GitHub 上下文，在专用 Slack 频道中回答产品问题。'],
    ['Product Finance Agent', '产品财务 Agent'],
    ['Analyze Stripe revenue, churn signals, and product pricing opportunities', '分析 Stripe 收入、流失信号和产品定价机会。'],
    ['Slack Digest Agent', 'Slack 摘要 Agent'],
    ["Summarize important DMs, mentions, and the user's top active Slack channels", '总结重要私信、提及内容以及该用户最活跃的 Slack 频道。'],
    ['Dashboard', '仪表盘'],
    ['No Agents Yet', '还没有 Agents'],
    ['Ask Cursor to build, fix bugs, explore', '让 Cursor 帮你构建、修复 bug、探索代码'],
    ['GPT-5.5 High', 'GPT-5.5 High'],
    ['MCPs', 'MCPs'],
    ['No MCP servers available', '没有可用的 MCP 服务器'],
    ['Use Multiple Models', '使用多个模型'],
    ['Long-running', '长时间运行'],
    ['Preview', '预览'],
    ['Apply maximum effort on any task', '对任何任务应用最高努力级别'],
    ['Run security audit', '运行安全审计'],
    ['Explore Marketplace', '浏览市场'],
    ['Try Commands', '试试 Commands'],
    ['Press /', '按下 /'],
    ['Wait for approval after planning', '规划完成后等待批准'],
    ['Running on Auto', '正在使用 Auto 运行'],
    ['Usage limits reached. This Agent is running on Auto for free.', '已达到用量上限。这个 Agent 正在免费使用 Auto 运行。'],
    ['Edit limits', '编辑限制'],
    ['Continue with Auto', '继续使用 Auto'],
    ['Overview', '概览'],
    ['Cloud Agents', '云代理'],
    ['Bugbot', 'Bugbot'],
    ['Automatically review pull requests (PRs) for bugs and issues. Bugbot runs are billed based on underlying agent usage.', '自动审查 pull requests（PRs）中的 bug 和问题。Bugbot 运行将按底层 agent 用量计费。'],
    ['Bugbot reviews are billed through your Cursor plan usage', 'Bugbot 审查会通过你的 Cursor 套餐用量计费'],
    ['Enable Bugbot on a repository to get started', '在仓库上启用 Bugbot 以开始使用'],
    ['To start using Bugbot, you need to enable it on at least one repository. Select an organization below to get started.', '要开始使用 Bugbot，你需要至少在一个仓库上启用它。请选择下方的一个组织以开始。'],
    ['Manage connected accounts and repositories', '管理已连接的账号和仓库'],
    ['Enable Bugbot', '启用 Bugbot'],
    ['Enable', '启用'],
    ['Source Control Providers', '源码控制提供方'],
    ['Plugins', '插件'],
    ['Integrations', '集成'],
    ['Shared Canvases', '共享画布'],
    ["All the Canvases you've shared from Cursor, in one place.", '你从 Cursor 分享的所有 Canvases 都会集中显示在这里。'],
    ['No Shared Canvases', '还没有共享画布'],
    ['Canvases you share from Cursor will appear here.', '你从 Cursor 分享的 Canvases 会显示在这里。'],
    ['Create Agents to edit and run code, asynchronously', '创建 Agents 以异步编辑和运行代码'],
    ['Environments', '环境'],
    ['New', '新建'],
    ['No environments configured', '尚未配置任何环境'],
    ['Start Setup', '开始设置'],
    ['Create environment', '创建环境'],
    ['Create a New Environment', '创建新环境'],
    ['Create a new environment by selecting one or more repositories.', '通过选择一个或多个仓库来创建新环境。'],
    ['Select one or more repositories.', '选择一个或多个仓库。'],
    ['Repositories', '仓库'],
    ['Select multiple', '多选'],
    ['Continue', '继续'],
    ['Self-Hosted', '自托管'],
    ['Monitor and manage your self-hosted cloud machines', '监控并管理你的自托管云机器'],
    ['Enable self-hosted pool', '启用自托管池'],
    ['Enable self-hosted pool to create a personal pool of workers.', '启用自托管池以创建个人 worker 池。'],
    ['My Machines', '我的机器'],
    ['View personal self-hosted workers and CLI commands to connect machines.', '查看个人自托管 workers 和连接机器所需的 CLI 命令。'],
    ['Defaults', '默认值'],
    ['Default Model', '默认模型'],
    ['Used when no model is specified', '在未指定模型时使用'],
    ['Select model', '选择模型'],
    ['Default Repository', '默认仓库'],
    ['Used when no repository is specified', '在未指定仓库时使用'],
    ['Select repository', '选择仓库'],
    ['Base Branch', '基础分支'],
    ["When empty, Cloud Agent will use a repository's default branch (recommended)", '留空时，Cloud Agent 将使用仓库的默认分支（推荐）'],
    ['Branch Prefix', '分支前缀'],
    ['Prefix for branch names created by Cloud Agent', 'Cloud Agent 创建分支名时使用的前缀'],
    ['Pull Requests', 'Pull Requests'],
    ['Security', '安全'],
    ['Create PRs', '创建 PR'],
    ['Automatically create a pull request when Cloud Agent completes.', 'Cloud Agent 完成后自动创建 pull request。'],
    ['For Single Model Runs', '适用于单模型运行'],
    ['Allow posting artifacts to GitHub', '允许将产物发布到 GitHub'],
    ['Allow cloud agents to embed images directly in PR descriptions using hard-to-guess public URLs.', '允许 cloud agents 使用难以猜测的公开 URL 将图片直接嵌入 PR 描述中。'],
    ['Allow cloud agents to embed images directly in PR descriptions using hard-to-guess public URLs. Learn more', '允许 cloud agents 使用难以猜测的公开 URL 将图片直接嵌入 PR 描述中。了解更多'],
    ['Link Only', '仅链接'],
    ['Notifications', '通知'],
    ['Slack Notifications', 'Slack 通知'],
    ['Get notified in Slack when a Cloud Agent completes a task', '当 Cloud Agent 完成任务时在 Slack 中接收通知'],
    ['Repository routing', '仓库路由'],
    ['Routing rules to help Cloud Agents pick the right repository.', '帮助 Cloud Agents 选择正确仓库的路由规则。'],
    ['Add Rule', '添加规则'],
    ['No routing rules yet', '还没有路由规则'],
    ['Network Access Settings', '网络访问设置'],
    ['Control which network destinations your cloud agents can access', '控制你的 cloud agents 可以访问哪些网络目标'],
    ['Allow all network access', '允许所有网络访问'],
    ['My Secrets', '我的 Secrets'],
    ['Securely set environment variables for your Cloud Agents.', '为你的 Cloud Agents 安全地设置环境变量。'],
    ['Add Secrets', '添加 Secrets'],
    ['No secrets yet', '还没有 Secrets'],
    ['Members', '成员'],
    ['Usage', '用量'],
    ['Spending', '支出'],
    ['Billing & Invoices', '计费与发票'],
    ['Language', '语言'],
    ['Default', '默认'],
    ['Chinese (Simplified)', '简体中文'],
    ['Privacy', '隐私'],
    ['Privacy Mode', '隐私模式'],
    ['Active', '已启用'],
    ['Edit', '编辑'],
    ['Learn More', '了解更多'],
    ['Learn more', '了解更多'],
    ['Student Verification', '学生认证'],
    ['Student Status', '学生状态'],
    ['Not eligible', '不符合条件'],
    ['Profile', '个人资料'],
    ['Email', '电子邮箱'],
    ['First Name', '名字'],
    ['Last Name', '姓氏'],
    ['Save', '保存'],
    ['Appearance', '外观'],
    ['Theme', '主题'],
    ['System', '跟随系统'],
    ['PR Preferences', 'PR 偏好'],
    ['Preferred PR destination', '首选 PR 打开位置'],
    ['Choose where PR links open across web, the desktop app and IDE.', '选择在网页、桌面应用和 IDE 中打开 PR 链接的位置。'],
    ['Source Control', '源码控制'],
    ['Connect', '连接'],
    ['Loading...', '加载中...'],
    ['Loading contribution data...', '正在加载贡献数据...'],
    ['Desktop App', '桌面应用'],
    ['About 1 hour ago', '约 1 小时前'],
    ['Showing 1-4 of 4', '显示第 1-4 项，共 4 项'],
    ['Connect GitHub for Cloud Agents, Bugbot and enhanced codebase context', '连接 GitHub 以用于 Cloud Agents、Bugbot 和增强代码库上下文'],
    ['Work with Cloud Agents from Slack', '在 Slack 中使用 Cloud Agents'],
    ["Connect external tools to extend your team's workflow.", '连接外部工具以扩展你团队的工作流。'],
    ['No API Keys Yet', '还没有 API Key'],
    ['New API Key', '新建 API Key'],
    ['Upgrade to Teams', '升级到 Teams'],
    ['Work with your team and unlock collaborative features', '与你的团队协作并解锁协作功能'],
    ['Create team', '创建团队'],
    ['Current Plan', '当前套餐'],
    ['CURRENT PLAN', '当前套餐'],
    ['On-Demand Spending', '按需支出'],
    ['Disabled', '已禁用'],
    ['Manage', '管理'],
    ['Switch to annual billing and save 20%', '切换到按年计费并节省 20%'],
    ['Manage in Stripe', '在 Stripe 中管理'],
    ['Paid', '已支付'],
    ['Cancel', '取消'],
    ['Extend Cursor with skills, rules, subagents, MCP tools, and hooks', '使用技能、规则、子代理、MCP 工具和 hooks 扩展 Cursor'],
    ['Included', '包含'],
    ['On-demand', '按需'],
    ['Model', '模型'],
    ['Tokens', 'Tokens'],
    ['Getting started', '开始使用'],
    ['Connect Slack', '连接 Slack'],
    ['Extend Cursor with plugins', '使用插件扩展 Cursor'],
    ['Set up your cloud environment for faster, parallelizable agents everywhere.', '设置你的云环境，以便在各处更快地并行运行代理。'],
    ['Work with Cloud Agents from Microsoft Teams', '在 Microsoft Teams 中使用 Cloud Agents'],
    ['Your code data will not be trained on or used to improve the product. Code may be stored for Cloud Agent, Team Rules, and other features.', '你的代码数据不会被用于训练或改进产品。代码可能会为 Cloud Agent、团队规则和其他功能而存储。'],
    ['Only .edu emails and specific educational domains are eligible for student verification.', '只有 .edu 邮箱和特定教育域名符合学生认证条件。'],
    ['Session revocation may take up to 10 minutes to complete.', '会话撤销最多可能需要 10 分钟完成。'],
    ['User API Keys provide secure, programmatic access to your Cursor account, including the headless version of the Cursor Agent CLI and Cloud Agent API.', '用户 API Key 可为你的 Cursor 账号提供安全的程序化访问，包括无头版 Cursor Agent CLI 和 Cloud Agent API。'],
    ['User API Keys provide secure, programmatic access to your Cursor account, including the headless version of the Cursor Agent CLI and', '用户 API Key 可为你的 Cursor 账号提供安全的程序化访问，包括无头版 Cursor Agent CLI 和'],
    ['User API Keys provide secure, programmatic access to your Cursor account, including the headless version of the Cursor Agent CLI', '用户 API Key 可为你的 Cursor 账号提供安全的程序化访问，包括无头版 Cursor Agent CLI'],
    ['and', '和'],
    ['. Treat them like passwords: keep them secure and never share them publicly.', '。请像对待密码一样妥善保管，切勿公开分享。'],
    ['Note: The', '注意：'],
    ['Treat them like passwords: keep them secure and never share them publicly.', '请像对待密码一样妥善保管，切勿公开分享。'],
    ['. Treat them like passwords: keep them secure and never share them publicly. Note: The', '。请像对待密码一样妥善保管，切勿公开分享。注意：'],
    ['Note: The Cloud Agent API is in beta.', '注意：Cloud Agent API 目前处于测试阶段。'],
    ['is in beta.', '目前处于测试阶段。'],
    ['Active Sessions', '活跃会话'],
    ['Device', '设备'],
    ['Created', '创建时间'],
    ['Web', '网页'],
    ['Revoke', '撤销'],
    ['Prev', '上一页'],
    ['Next', '下一页'],
    ['More', '更多'],
    ['Log Out', '退出登录'],
    ['Delete Account', '删除账号'],
    ['Delete', '删除'],
    ['Create a Team', '创建团队'],
    ['Back to Agents', '返回 Agents'],
]);

const PATTERN_TRANSLATIONS = [
    {
        pattern: /^(\d+\/\d+)\s+Completed$/u,
        replace: (_, progress) => `已完成 ${progress}`,
    },
    {
        pattern: /^(\d+)\/(\d+)\s+Repositories Enabled$/u,
        replace: (_, enabled, total) => `已启用 ${enabled}/${total} 个仓库`,
    },
    {
        pattern: /^(\d+)\s+Repositories Available$/u,
        replace: (_, count) => `有 ${count} 个仓库可用`,
    },
    {
        pattern: /^About\s+(\d+)\s+hour(?:s)?\s+ago$/u,
        replace: (_, hours) => `约 ${hours} 小时前`,
    },
    {
        pattern: /^Showing\s+(.+?)\s+of\s+(\d+)$/u,
        replace: (_, range, total) => `显示第 ${range} 项，共 ${total} 项`,
    },
    {
        pattern: /^May\s+(\d+)\s+-\s+May\s+(\d+)$/u,
        replace: (_, startDay, endDay) => `5月${startDay}日 - 5月${endDay}日`,
    },
    {
        pattern: /^Connected as\s+(.+?)\s+to repositories in organizations:\s+(.+)$/u,
        replace: (_, account, organizations) => `已使用 ${account} 连接到这些组织中的仓库：${organizations}`,
    },
    {
        pattern: /^Connect\s+(GitHub|GitLab)\s+for Cloud Agents, Bugbot and enhanced codebase context$/u,
        replace: (_, provider) => `连接 ${provider} 以用于 Cloud Agents、Bugbot 和增强代码库上下文`,
    },
    {
        pattern: /^Connect a\s+(Linear workspace|Jira site)\s+to delegate issues to Cloud Agents$/u,
        replace: (_, target) => {
            if (target === 'Linear workspace') {
                return '连接 Linear 工作区以将问题委派给 Cloud Agents';
            }
            return '连接 Jira 站点以将问题委派给 Cloud Agents';
        },
    },
    {
        pattern: /^Need enterprise features\?$/u,
        replace: () => '需要企业级功能？',
    },
    {
        pattern: /^Contact sales$/u,
        replace: () => '联系销售',
    },
    {
        pattern: /^Team Management$/u,
        replace: () => '团队管理',
    },
    {
        pattern: /^Usage Analytics$/u,
        replace: () => '用量分析',
    },
    {
        pattern: /^Admin Controls$/u,
        replace: () => '管理员控制',
    },
    {
        pattern: /^Rules & Commands$/u,
        replace: () => '规则与命令',
    },
    {
        pattern: /^Invite members, manage roles, and control access$/u,
        replace: () => '邀请成员、管理角色并控制访问权限',
    },
    {
        pattern: /^Track team usage and optimize your subscription$/u,
        replace: () => '跟踪团队用量并优化你的订阅',
    },
    {
        pattern: /^Centralized billing and privacy mode controls$/u,
        replace: () => '集中管理计费和隐私模式控制',
    },
    {
        pattern: /^Share rules and commands across your team$/u,
        replace: () => '在团队内共享规则和命令',
    },
    {
        pattern: /^Get pooled usage, SCIM seat management, and granular admin controls$/u,
        replace: () => '获取汇总用量、SCIM 席位管理和精细化管理员控制',
    },
    {
        pattern: /^Last month$/u,
        replace: () => '上个月',
    },
    {
        pattern: /^Total spend$/u,
        replace: () => '总支出',
    },
    {
        pattern: /^Your Usage$/u,
        replace: () => '你的用量',
    },
    {
        pattern: /^Your usage per day across this billing period$/u,
        replace: () => '你在当前计费周期内的每日用量',
    },
    {
        pattern: /^Group By: Model$/u,
        replace: () => '分组方式：模型',
    },
    {
        pattern: /^Metric: Spend$/u,
        replace: () => '指标：支出',
    },
    {
        pattern: /^Cumulative Spend$/u,
        replace: () => '累计支出',
    },
    {
        pattern: /^Export CSV$/u,
        replace: () => '导出 CSV',
    },
    {
        pattern: /^Showing token usage and costs from (.+) to (.+)\. Use filters to narrow results by date range\.$/u,
        replace: (_, start, end) => `显示从 ${start} 到 ${end} 的 token 用量和费用。可使用筛选器按日期范围缩小结果。`,
    },
    {
        pattern: /^Rows:\s*(\d+)$/u,
        replace: (_, rows) => `行数：${rows}`,
    },
    {
        pattern: /^Resets on (.+)$/u,
        replace: (_, dateText) => `将于 ${dateText} 重置`,
    },
    {
        pattern: /^(\d+)% Auto and (\d+)% API used$/u,
        replace: (_, autoPercent, apiPercent) => `已使用 ${autoPercent}% Auto 和 ${apiPercent}% API`,
    },
    {
        pattern: /^Cycle Starting (.+)$/u,
        replace: (_, dateText) => `周期开始于 ${dateText}`,
    },
    {
        pattern: /^Adjust plan$/u,
        replace: () => '调整套餐',
    },
    {
        pattern: /^Included in Ultra$/u,
        replace: () => 'Ultra 包含',
    },
    {
        pattern: /^Total$/u,
        replace: () => '总计',
    },
    {
        pattern: /^On-Demand Usage$/u,
        replace: () => '按需用量',
    },
    {
        pattern: /^On-demand spending is currently disabled$/u,
        replace: () => '当前已禁用按需支出',
    },
    {
        pattern: /^Monthly Limit$/u,
        replace: () => '月度上限',
    },
    {
        pattern: /^Set a fixed amount or make it unlimited\.$/u,
        replace: () => '设置固定金额或设为无限制。',
    },
    {
        pattern: /^Upgrade Now$/u,
        replace: () => '立即升级',
    },
    {
        pattern: /^Get maximum value with 20x usage limits and early access to advanced features\.$/u,
        replace: () => '通过 20 倍用量上限和高级功能抢先体验获得最大价值。',
    },
    {
        pattern: /^Your subscription will auto renew on (.+)\.$/u,
        replace: (_, dateText) => `你的订阅将于 ${dateText} 自动续费。`,
    },
    {
        pattern: /^0% Auto and 0% API used$/u,
        replace: () => '已使用 0% Auto 和 0% API',
    },
    {
        pattern: /^Payment$/u,
        replace: () => '付款',
    },
    {
        pattern: /^Update your payment details$/u,
        replace: () => '更新你的付款信息',
    },
    {
        pattern: /^Included Usage$/u,
        replace: () => '包含用量',
    },
    {
        pattern: /^Item$/u,
        replace: () => '项目',
    },
    {
        pattern: /^Type$/u,
        replace: () => '类型',
    },
    {
        pattern: /^Cost$/u,
        replace: () => '费用',
    },
    {
        pattern: /^Qty$/u,
        replace: () => '数量',
    },
    {
        pattern: /^Subtotal:$/u,
        replace: () => '小计：',
    },
    {
        pattern: /^Invoices$/u,
        replace: () => '发票',
    },
    {
        pattern: /^Date$/u,
        replace: () => '日期',
    },
    {
        pattern: /^Description$/u,
        replace: () => '说明',
    },
    {
        pattern: /^Status$/u,
        replace: () => '状态',
    },
    {
        pattern: /^Amount$/u,
        replace: () => '金额',
    },
    {
        pattern: /^Invoice$/u,
        replace: () => '发票',
    },
    {
        pattern: /^View$/u,
        replace: () => '查看',
    },
    {
        pattern: /^We'll be sad to see you go\.$/u,
        replace: () => '看到你离开我们会很难过。',
    },
    {
        pattern: /^User API Keys$/u,
        replace: () => '用户 API Key',
    },
    {
        pattern: /^No API Keys have been created yet$/u,
        replace: () => '还没有创建任何 API Key',
    },
    {
        pattern: /^User API Keys provide secure, programmatic access to your Cursor account, including the headless version of the Cursor Agent CLI and Cloud Agent API\. Treat them like passwords: keep them secure and never share them publicly\. Note: The Cloud Agent API is in beta\.$/u,
        replace: () => '用户 API Key 可为你的 Cursor 账号提供安全的程序化访问，包括无头版 Cursor Agent CLI 和 Cloud Agent API。请像对待密码一样妥善保管，切勿公开分享。注意：Cloud Agent API 目前处于测试阶段。',
    },
    {
        pattern: /^All$/u,
        replace: () => '全部',
    },
    {
        pattern: /^Required$/u,
        replace: () => '必需',
    },
    {
        pattern: /^Optional$/u,
        replace: () => '可选',
    },
    {
        pattern: /^Add$/u,
        replace: () => '添加',
    },
    {
        pattern: /^Core skills library: TDD, debugging, collaboration patterns, and proven techniques$/u,
        replace: () => '核心技能库：TDD、调试、协作模式和经过验证的实践',
    },
];

function normalizeLanguageMode(value) {
    if (typeof value !== 'string') return 'default';

    const normalized = value.trim();
    if (!normalized) return 'default';
    if (normalized.toLowerCase() === 'default') return 'default';

    return LANGUAGE_MODES.has(normalized) ? normalized : 'default';
}

function shouldSkipTranslationForContext(context = {}) {
    const text = String(context.text || '').trim();
    const ancestorText = String(context.ancestorText || '');
    if (!text) return false;

    // GitLab frequently renders a transient loading button before it settles
    // to its actual stable action. Leave that state untranslated so we do not
    // mislabel the row as a permanent action.
    if (text === 'Loading...' && ancestorText.includes('GitLab')) {
        return true;
    }

    return false;
}

function createTranslationEngine() {
    function translateText(text, languageMode) {
        if (normalizeLanguageMode(languageMode) === 'default') {
            return text;
        }

        const raw = String(text);
        const match = raw.match(/^(\s*)(.*?)(\s*)$/su);
        if (!match) {
            return raw;
        }

        const [, leadingWhitespace, coreText, trailingWhitespace] = match;
        const translated = EXACT_TRANSLATIONS.get(coreText);
        if (translated) {
            return `${leadingWhitespace}${translated}${trailingWhitespace}`;
        }

        for (const entry of PATTERN_TRANSLATIONS) {
            if (!entry.pattern.test(coreText)) continue;
            const replaced = coreText.replace(entry.pattern, entry.replace);
            return `${leadingWhitespace}${replaced}${trailingWhitespace}`;
        }

        return raw;
    }

    return {
        translateText,
    };
}

module.exports = {
    normalizeLanguageMode,
    createTranslationEngine,
    shouldSkipTranslationForContext,
};
