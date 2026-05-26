const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
    normalizeLanguageMode,
    createTranslationEngine,
    shouldSkipTranslationForContext,
    shouldRebuildSettingsRow,
} = require('./cursor-language-switch-core.cjs');

function loadUserscriptTestApi() {
    const scriptPath = path.join(__dirname, 'Cursor Dashboard Language Switch.user.js');
    const code = fs.readFileSync(scriptPath, 'utf8');
    const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        window: {},
        document: {
            readyState: 'loading',
            addEventListener() {},
            createElement() {
                return {
                    style: {},
                    setAttribute() {},
                    append() {},
                    appendChild() {},
                    remove() {},
                    textContent: '',
                    id: '',
                    className: '',
                };
            },
            body: {
                appendChild() {},
            },
        },
        location: {
            href: 'https://cursor.com/cn/dashboard/settings',
            pathname: '/cn/dashboard/settings',
        },
        MutationObserver: class {
            observe() {}
            disconnect() {}
        },
        GM_getValue: async () => 'default',
        GM_setValue: async () => {},
        GM_addStyle() {},
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: scriptPath });
    return sandbox.__cursorLanguageSwitchTest;
}

test('normalizes language mode values to supported storage keys', () => {
    assert.equal(normalizeLanguageMode(undefined), 'default');
    assert.equal(normalizeLanguageMode('DEFAULT'), 'default');
    assert.equal(normalizeLanguageMode('zh-CN'), 'zh-CN');
    assert.equal(normalizeLanguageMode('unknown-mode'), 'default');
});

test('provides seed translations for the language selector shell', () => {
    const engine = createTranslationEngine();

    assert.equal(engine.translateText('Language', 'zh-CN'), '语言');
    assert.equal(engine.translateText('Default', 'zh-CN'), '默认');
    assert.equal(engine.translateText('Chinese (Simplified)', 'zh-CN'), '简体中文');
    assert.equal(engine.translateText('Language', 'default'), 'Language');
});

test('translates common Cursor dashboard labels while preserving proper nouns', () => {
    const engine = createTranslationEngine();

    assert.equal(engine.translateText('New Agent', 'zh-CN'), '新建 Agent');
    assert.equal(engine.translateText('Automations', 'zh-CN'), '自动化');
    assert.equal(engine.translateText('Create an Automation', 'zh-CN'), '创建自动化');
    assert.equal(engine.translateText("All the Canvases you've shared from Cursor, in one place.", 'zh-CN'), '你从 Cursor 分享的所有 Canvases 都会集中显示在这里。');
    assert.equal(engine.translateText('No Shared Canvases', 'zh-CN'), '还没有共享画布');
    assert.equal(engine.translateText('Canvases you share from Cursor will appear here.', 'zh-CN'), '你从 Cursor 分享的 Canvases 会显示在这里。');
    assert.equal(
        engine.translateText('Save time by automating repetitive tasks with always-on agents that respond to triggers.', 'zh-CN'),
        '使用可持续运行并响应触发器的 agents 自动化重复任务，节省时间。',
    );
    assert.equal(engine.translateText('Popular', 'zh-CN'), '热门');
    assert.equal(engine.translateText('Code Review', 'zh-CN'), '代码审查');
    assert.equal(engine.translateText('Incidents & Triage', 'zh-CN'), '事故与分诊');
    assert.equal(engine.translateText('Data & Research', 'zh-CN'), '数据与研究');
    assert.equal(engine.translateText('Find bugs', 'zh-CN'), '查找 bug');
    assert.equal(engine.translateText('Find critical bugs', 'zh-CN'), '查找关键 bug');
    assert.equal(
        engine.translateText('Analyze recent commits for high-severity correctness bugs and submit safe fixes', 'zh-CN'),
        '分析最近的提交，找出高严重性的正确性 bug，并提交安全修复。',
    );
    assert.equal(engine.translateText('Find vulnerabilities', 'zh-CN'), '查找漏洞');
    assert.equal(
        engine.translateText('Review pull requests for exploitable security issues and flag only validated findings before merge', 'zh-CN'),
        '在合并前审查 pull requests 中可被利用的安全问题，并且只标记已验证的发现。',
    );
    assert.equal(engine.translateText('Assign PR reviewers', 'zh-CN'), '分配 PR 审查者');
    assert.equal(
        engine.translateText('Assign reviewers based on code changes and auto-approve low-risk PRs', 'zh-CN'),
        '根据代码变更分配审查者，并自动批准低风险 PR。',
    );
    assert.equal(engine.translateText('Monitor engineering invariants', 'zh-CN'), '监控工程不变量');
    assert.equal(
        engine.translateText('Re-check critical repository invariants on a schedule and alert only when a rule regresses', 'zh-CN'),
        '按计划重新检查仓库中的关键不变量，并且仅在规则退化时发出提醒。',
    );
    assert.equal(engine.translateText('Remediate dependency vulnerabilities', 'zh-CN'), '修复依赖漏洞');
    assert.equal(
        engine.translateText('Triage dependency-vulnerability tickets from Linear and open upgrade PRs when the fix is safe', 'zh-CN'),
        '分诊来自 Linear 的依赖漏洞工单，并在修复安全时创建升级 PR。',
    );
    assert.equal(engine.translateText('Scan codebase for vulnerabilities', 'zh-CN'), '扫描代码库中的漏洞');
    assert.equal(
        engine.translateText('Review the full repository on a schedule and alert on validated high-impact security issues', 'zh-CN'),
        '按计划审查整个仓库，并对已验证的高影响安全问题发出提醒。',
    );
    assert.equal(engine.translateText('Generate docs', 'zh-CN'), '生成文档');
    assert.equal(
        engine.translateText('Create and update developer documentation for recently changed or under-documented code', 'zh-CN'),
        '为最近变更或文档不足的代码创建并更新开发者文档。',
    );
    assert.equal(engine.translateText('Add test coverage', 'zh-CN'), '补充测试覆盖');
    assert.equal(
        engine.translateText('Review recent changes and add tests for high-risk logic that lacks adequate coverage', 'zh-CN'),
        '审查最近的变更，并为缺少充分覆盖的高风险逻辑补充测试。',
    );
    assert.equal(engine.translateText('Fix bugs reported in Slack', 'zh-CN'), '修复 Slack 中报告的 bug');
    assert.equal(
        engine.translateText('Monitor a Slack channel for bug reports, investigate the codebase, and fix with a PR', 'zh-CN'),
        '监控 Slack 频道中的 bug 报告，调查代码库，并通过 PR 进行修复。',
    );
    assert.equal(engine.translateText('Fix CI failures', 'zh-CN'), '修复 CI 失败');
    assert.equal(
        engine.translateText('Detect CI failures on main and automatically open PRs', 'zh-CN'),
        '检测 main 分支上的 CI 失败并自动创建 PR。',
    );
    assert.equal(engine.translateText('Investigate PagerDuty incidents', 'zh-CN'), '调查 PagerDuty 事故');
    assert.equal(
        engine.translateText('Investigate incidents using Datadog and code context', 'zh-CN'),
        '结合 Datadog 和代码上下文调查事故。',
    );
    assert.equal(engine.translateText('Investigate Sentry issues', 'zh-CN'), '调查 Sentry 问题');
    assert.equal(
        engine.translateText('Investigate errors from Sentry, identify root causes, and propose fixes', 'zh-CN'),
        '调查来自 Sentry 的错误，找出根因，并提出修复方案。',
    );
    assert.equal(engine.translateText('Investigate top Datadog errors', 'zh-CN'), '调查 Datadog 高发错误');
    assert.equal(
        engine.translateText('Investigate recurring production errors from Datadog, identify root causes, and propose fixes', 'zh-CN'),
        '调查 Datadog 中反复出现的生产错误，找出根因，并提出修复方案。',
    );
    assert.equal(engine.translateText('Triage Linear issues', 'zh-CN'), '分诊 Linear 问题');
    assert.equal(
        engine.translateText('Triage new issues by investigating bugs, planning feature requests, and opening PRs for easy fixes', 'zh-CN'),
        '通过调查 bug、规划功能请求，以及为简单修复创建 PR 来分诊新问题。',
    );
    assert.equal(engine.translateText('Summarize changes daily', 'zh-CN'), '每日汇总变更');
    assert.equal(
        engine.translateText('Post a daily Slack digest summarizing notable repository changes and risks from the previous day', 'zh-CN'),
        '每天在 Slack 发布摘要，总结前一天仓库中的重要变更和风险。',
    );
    assert.equal(engine.translateText('Customer Health Monitoring Agent', 'zh-CN'), '客户健康监控 Agent');
    assert.equal(
        engine.translateText('Find at-risk customers using usage analytics, call notes, Slack escalations, and Linear blockers', 'zh-CN'),
        '结合用量分析、通话记录、Slack 升级和 Linear 阻塞项来识别有流失风险的客户。',
    );
    assert.equal(engine.translateText('Product Analytics Agent', 'zh-CN'), '产品分析 Agent');
    assert.equal(
        engine.translateText('Weekly product usage, activation, retention, and feature adoption digest from Databricks', 'zh-CN'),
        '来自 Databricks 的每周产品用量、激活、留存和功能采用摘要。',
    );
    assert.equal(engine.translateText('Product FAQ Agent', 'zh-CN'), '产品 FAQ Agent');
    assert.equal(
        engine.translateText('Answer product questions in a dedicated Slack channel using Slack, Notion, Linear, and GitHub context', 'zh-CN'),
        '结合 Slack、Notion、Linear 和 GitHub 上下文，在专用 Slack 频道中回答产品问题。',
    );
    assert.equal(engine.translateText('Product Finance Agent', 'zh-CN'), '产品财务 Agent');
    assert.equal(
        engine.translateText('Analyze Stripe revenue, churn signals, and product pricing opportunities', 'zh-CN'),
        '分析 Stripe 收入、流失信号和产品定价机会。',
    );
    assert.equal(engine.translateText('Slack Digest Agent', 'zh-CN'), 'Slack 摘要 Agent');
    assert.equal(
        engine.translateText("Summarize important DMs, mentions, and the user's top active Slack channels", 'zh-CN'),
        '总结重要私信、提及内容以及该用户最活跃的 Slack 频道。',
    );
    assert.equal(engine.translateText('Dashboard', 'zh-CN'), '仪表盘');
    assert.equal(engine.translateText('No Agents Yet', 'zh-CN'), '还没有 Agents');
    assert.equal(engine.translateText('Ask Cursor to build, fix bugs, explore', 'zh-CN'), '让 Cursor 帮你构建、修复 bug、探索代码');
    assert.equal(engine.translateText('No MCP servers available', 'zh-CN'), '没有可用的 MCP 服务器');
    assert.equal(engine.translateText('Use Multiple Models', 'zh-CN'), '使用多个模型');
    assert.equal(engine.translateText('Long-running', 'zh-CN'), '长时间运行');
    assert.equal(engine.translateText('Preview', 'zh-CN'), '预览');
    assert.equal(engine.translateText('Apply maximum effort on any task', 'zh-CN'), '对任何任务应用最高努力级别');
    assert.equal(engine.translateText('Run security audit', 'zh-CN'), '运行安全审计');
    assert.equal(engine.translateText('Explore Marketplace', 'zh-CN'), '浏览市场');
    assert.equal(engine.translateText('Try Commands', 'zh-CN'), '试试 Commands');
    assert.equal(engine.translateText('Press /', 'zh-CN'), '按下 /');
    assert.equal(engine.translateText('Wait for approval after planning', 'zh-CN'), '规划完成后等待批准');
    assert.equal(engine.translateText('Running on Auto', 'zh-CN'), '正在使用 Auto 运行');
    assert.equal(engine.translateText('Usage limits reached. This Agent is running on Auto for free.', 'zh-CN'), '已达到用量上限。这个 Agent 正在免费使用 Auto 运行。');
    assert.equal(engine.translateText('Edit limits', 'zh-CN'), '编辑限制');
    assert.equal(engine.translateText('Continue with Auto', 'zh-CN'), '继续使用 Auto');
    assert.equal(engine.translateText('Settings', 'zh-CN'), '设置');
    assert.equal(
        engine.translateText('Automatically review pull requests (PRs) for bugs and issues. Bugbot runs are billed based on underlying agent usage.', 'zh-CN'),
        '自动审查 pull requests（PRs）中的 bug 和问题。Bugbot 运行将按底层 agent 用量计费。',
    );
    assert.equal(
        engine.translateText('Bugbot reviews are billed through your Cursor plan usage', 'zh-CN'),
        'Bugbot 审查会通过你的 Cursor 套餐用量计费',
    );
    assert.equal(engine.translateText('Enable Bugbot on a repository to get started', 'zh-CN'), '在仓库上启用 Bugbot 以开始使用');
    assert.equal(
        engine.translateText('To start using Bugbot, you need to enable it on at least one repository. Select an organization below to get started.', 'zh-CN'),
        '要开始使用 Bugbot，你需要至少在一个仓库上启用它。请选择下方的一个组织以开始。',
    );
    assert.equal(engine.translateText('Manage connected accounts and repositories', 'zh-CN'), '管理已连接的账号和仓库');
    assert.equal(engine.translateText('Enable Bugbot', 'zh-CN'), '启用 Bugbot');
    assert.equal(engine.translateText('Enable', 'zh-CN'), '启用');
    assert.equal(engine.translateText('Source Control Providers', 'zh-CN'), '源码控制提供方');
    assert.equal(engine.translateText('Members', 'zh-CN'), '成员');
    assert.equal(engine.translateText('Usage', 'zh-CN'), '用量');
    assert.equal(engine.translateText('Billing & Invoices', 'zh-CN'), '计费与发票');
    assert.equal(
        engine.translateText('Preferred PR destination', 'zh-CN'),
        '首选 PR 打开位置',
    );
    assert.equal(
        engine.translateText('Choose where PR links open across web, the desktop app and IDE.', 'zh-CN'),
        '选择在网页、桌面应用和 IDE 中打开 PR 链接的位置。',
    );
    assert.equal(engine.translateText('Shared Canvases', 'zh-CN'), '共享画布');
    assert.equal(engine.translateText('Create Agents to edit and run code, asynchronously', 'zh-CN'), '创建 Agents 以异步编辑和运行代码');
    assert.equal(engine.translateText('Environments', 'zh-CN'), '环境');
    assert.equal(engine.translateText('No environments configured', 'zh-CN'), '尚未配置任何环境');
    assert.equal(engine.translateText('Start Setup', 'zh-CN'), '开始设置');
    assert.equal(engine.translateText('Self-Hosted', 'zh-CN'), '自托管');
    assert.equal(engine.translateText('Default Model', 'zh-CN'), '默认模型');
    assert.equal(engine.translateText('Default Repository', 'zh-CN'), '默认仓库');
    assert.equal(engine.translateText('Base Branch', 'zh-CN'), '基础分支');
    assert.equal(engine.translateText('Pull Requests', 'zh-CN'), 'Pull Requests');
    assert.equal(engine.translateText('Security', 'zh-CN'), '安全');
    assert.equal(engine.translateText('Learn more', 'zh-CN'), '了解更多');
    assert.equal(engine.translateText('Create PRs', 'zh-CN'), '创建 PR');
    assert.equal(
        engine.translateText('Allow cloud agents to embed images directly in PR descriptions using hard-to-guess public URLs.', 'zh-CN'),
        '允许 cloud agents 使用难以猜测的公开 URL 将图片直接嵌入 PR 描述中。',
    );
    assert.equal(engine.translateText('Network Access Settings', 'zh-CN'), '网络访问设置');
    assert.equal(engine.translateText('My Secrets', 'zh-CN'), '我的 Secrets');
    assert.equal(engine.translateText('Create environment', 'zh-CN'), '创建环境');
    assert.equal(engine.translateText('Create a New Environment', 'zh-CN'), '创建新环境');
    assert.equal(engine.translateText('Create a new environment by selecting one or more repositories.', 'zh-CN'), '通过选择一个或多个仓库来创建新环境。');
    assert.equal(engine.translateText('Select one or more repositories.', 'zh-CN'), '选择一个或多个仓库。');
    assert.equal(engine.translateText('Repositories', 'zh-CN'), '仓库');
    assert.equal(engine.translateText('Select multiple', 'zh-CN'), '多选');
    assert.equal(engine.translateText('Continue', 'zh-CN'), '继续');
    assert.equal(engine.translateText('Source Control', 'zh-CN'), '源码控制');
    assert.equal(engine.translateText('Connect', 'zh-CN'), '连接');
    assert.equal(engine.translateText('Loading...', 'zh-CN'), '加载中...');
    assert.equal(engine.translateText('Loading contribution data...', 'zh-CN'), '正在加载贡献数据...');
    assert.equal(engine.translateText('Desktop App', 'zh-CN'), '桌面应用');
    assert.equal(engine.translateText('About 1 hour ago', 'zh-CN'), '约 1 小时前');
    assert.equal(engine.translateText('Showing 1-4 of 4', 'zh-CN'), '显示第 1-4 项，共 4 项');
    assert.equal(
        engine.translateText('Connect GitHub for Cloud Agents, Bugbot and enhanced codebase context', 'zh-CN'),
        '连接 GitHub 以用于 Cloud Agents、Bugbot 和增强代码库上下文',
    );
    assert.equal(
        engine.translateText('Work with Cloud Agents from Slack', 'zh-CN'),
        '在 Slack 中使用 Cloud Agents',
    );
    assert.equal(engine.translateText('GitHub', 'zh-CN'), 'GitHub');
});

test('translates dynamic dashboard phrases without changing variable content', () => {
    const engine = createTranslationEngine();

    assert.equal(engine.translateText('2/4 Completed', 'zh-CN'), '已完成 2/4');
    assert.equal(engine.translateText('0/35 Repositories Enabled', 'zh-CN'), '已启用 0/35 个仓库');
    assert.equal(engine.translateText('0 Repositories Available', 'zh-CN'), '有 0 个仓库可用');
    assert.equal(engine.translateText('About 1 hour ago', 'zh-CN'), '约 1 小时前');
    assert.equal(engine.translateText('About 3 hours ago', 'zh-CN'), '约 3 小时前');
    assert.equal(engine.translateText('Showing 1-4 of 4', 'zh-CN'), '显示第 1-4 项，共 4 项');
    assert.equal(
        engine.translateText('Connected as millionart to repositories in organizations: millionart', 'zh-CN'),
        '已使用 millionart 连接到这些组织中的仓库：millionart',
    );
    assert.equal(
        engine.translateText('Connect GitLab for Cloud Agents, Bugbot and enhanced codebase context', 'zh-CN'),
        '连接 GitLab 以用于 Cloud Agents、Bugbot 和增强代码库上下文',
    );
    assert.equal(
        engine.translateText('Connect a Jira site to delegate issues to Cloud Agents', 'zh-CN'),
        '连接 Jira 站点以将问题委派给 Cloud Agents',
    );
    assert.equal(
        engine.translateText("Connect external tools to extend your team's workflow.", 'zh-CN'),
        '连接外部工具以扩展你团队的工作流。',
    );
    assert.equal(engine.translateText('No API Keys Yet', 'zh-CN'), '还没有 API Key');
    assert.equal(engine.translateText('New API Key', 'zh-CN'), '新建 API Key');
    assert.equal(engine.translateText('Upgrade to Teams', 'zh-CN'), '升级到 Teams');
    assert.equal(engine.translateText('Work with your team and unlock collaborative features', 'zh-CN'), '与你的团队协作并解锁协作功能');
    assert.equal(engine.translateText('Create team', 'zh-CN'), '创建团队');
    assert.equal(engine.translateText('CURRENT PLAN', 'zh-CN'), '当前套餐');
    assert.equal(engine.translateText('On-Demand Spending', 'zh-CN'), '按需支出');
    assert.equal(engine.translateText('Disabled', 'zh-CN'), '已禁用');
    assert.equal(engine.translateText('Manage', 'zh-CN'), '管理');
    assert.equal(engine.translateText('Switch to annual billing and save 20%', 'zh-CN'), '切换到按年计费并节省 20%');
    assert.equal(engine.translateText('Manage in Stripe', 'zh-CN'), '在 Stripe 中管理');
    assert.equal(engine.translateText('Paid', 'zh-CN'), '已支付');
    assert.equal(engine.translateText('Cancel', 'zh-CN'), '取消');
    assert.equal(engine.translateText('Extend Cursor with skills, rules, subagents, MCP tools, and hooks', 'zh-CN'), '使用技能、规则、子代理、MCP 工具和 hooks 扩展 Cursor');
    assert.equal(
        engine.translateText('User API Keys provide secure, programmatic access to your Cursor account, including the headless version of the Cursor Agent CLI and ', 'zh-CN'),
        '用户 API Key 可为你的 Cursor 账号提供安全的程序化访问，包括无头版 Cursor Agent CLI 和 ',
    );
    assert.equal(
        engine.translateText('User API Keys provide secure, programmatic access to your Cursor account, including the headless version of the Cursor Agent CLI', 'zh-CN'),
        '用户 API Key 可为你的 Cursor 账号提供安全的程序化访问，包括无头版 Cursor Agent CLI',
    );
    assert.equal(engine.translateText(' and ', 'zh-CN'), ' 和 ');
    assert.equal(
        engine.translateText('. Treat them like passwords: keep them secure and never share them publicly.', 'zh-CN'),
        '。请像对待密码一样妥善保管，切勿公开分享。',
    );
    assert.equal(engine.translateText(' Note: The ', 'zh-CN'), ' 注意： ');
    assert.equal(
        engine.translateText('. Treat them like passwords: keep them secure and never share them publicly. Note: The ', 'zh-CN'),
        '。请像对待密码一样妥善保管，切勿公开分享。注意： ',
    );
    assert.equal(engine.translateText(' is in beta.', 'zh-CN'), ' 目前处于测试阶段。');
});

test('userscript exposes a stable test API for file-tracking setup', () => {
    const api = loadUserscriptTestApi();

    assert.equal(api.SCRIPT_VERSION, '0.1.25');
    assert.equal(api.LANGUAGE_STORAGE_KEY, 'cursor-dashboard-language-switch:language');
    assert.equal(api.DEFAULT_LANGUAGE_MODE, 'default');
    assert.equal(api.CHINESE_LANGUAGE_MODE, 'zh-CN');
    assert.equal(api.VERSION_MARKER_ID, 'cursor-language-switch-version-marker');
    assert.equal(api.SETTINGS_ROW_ID, 'cursor-language-switch-setting');
    assert.equal(api.SETTINGS_BUTTON_ID, 'cursor-language-switch-trigger');
});

test('skips translating transient GitLab loading buttons until they stabilize', () => {
    assert.equal(
        shouldSkipTranslationForContext({
            text: 'Loading...',
            ancestorText: 'GitLab Connect GitLab for Cloud Agents, Bugbot and enhanced codebase context Loading...',
        }),
        true,
    );

    assert.equal(
        shouldSkipTranslationForContext({
            text: 'Loading...',
            ancestorText: 'GitHub Connect GitHub for Cloud Agents, Bugbot and enhanced codebase context Loading...',
        }),
        false,
    );

    assert.equal(
        shouldSkipTranslationForContext({
            text: 'Connect',
            ancestorText: 'GitLab Connect GitLab for Cloud Agents, Bugbot and enhanced codebase context Connect',
        }),
        false,
    );
});

test('does not rebuild the language row while the language select is active', () => {
    assert.equal(
        shouldRebuildSettingsRow({
            hasExistingRow: false,
            activeElementId: '',
            settingsButtonId: 'cursor-language-switch-trigger',
        }),
        true,
    );

    assert.equal(
        shouldRebuildSettingsRow({
            hasExistingRow: true,
            activeElementId: 'cursor-language-switch-trigger',
            settingsButtonId: 'cursor-language-switch-trigger',
        }),
        false,
    );

    assert.equal(
        shouldRebuildSettingsRow({
            hasExistingRow: true,
            activeElementId: '',
            settingsButtonId: 'cursor-language-switch-trigger',
        }),
        false,
    );
});
