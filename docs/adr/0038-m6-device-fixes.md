# ADR 0038 · M6 真机问题:DSML 工具调用、fake-IP、审批可见性、任务预授权

状态:已采纳(随 PR「fix(tasks): M6 真机问题」)。背景:M6 真机测试(Windows、DeepSeek deepseek-flash、Clash fake-IP 模式)手动运行一个 `agent_prompt` 任务时暴露的问题。

## 1. 模型把工具调用写成正文(DSML)

现象:最后一条助手消息的正文是 `<｜｜DSML｜｜ …invoke name="mail__list">…`,没有变成工具调用,运行却记为 succeeded。

决定:

1. openai-compatible 适配器在流式正文里**截下** DSML 标记(竖线全角 / 半角、数量不限),不当正文输出;流结束后解析成真正的工具调用(`invoke name` + `parameter name`,`string="false"` 的参数按 JSON 解析;也接受参数写成 JSON 对象的变体)。
2. 解析不了(标记不完整、没有名字),或这次请求根本没给工具:抛 `ProviderError('malformed_tool_call')`,**绝不**展示标记。已有结构化 `tool_calls` 时,正文里的标记被丢弃。
3. 整条回答没有任何内容(没有文字、也没调用过工具):runner 抛 `empty_response`,运行记为 failed。任务另外要求:没有渠道输出时,助手消息最后一段必须是文字,否则记 `empty_answer`;`malformed_tool_call` 记 `tool_call_malformed`。这两个任务错误码**不重试**(重试只会得到同样的结果)。
4. 契约(只增):`ProviderErrorCode` 增 `malformed_tool_call`、`empty_response`(同步进模型连接测试的错误枚举);`TaskErrorCode` 增 `empty_answer`、`tool_call_malformed`。任务页用中文显示原因。

## 2. web.fetch 与 fake-IP(198.18.0.0/15)

现象:Clash 的 fake-IP 模式把所有域名解析到 198.18.0.0/15,被 net-guard 当作「基准测试」保留段拦下,web.fetch 对任何网站都失败。

备选:

- (a) 支持经 `HTTP(S)_PROXY` 发请求,走代理时不做本地 DNS 校验。
- (b) 设置里加开关「允许 fake-IP 段 198.18.0.0/15」,默认关闭。

**选 (b)。** 理由:

- (a) 要自己实现 CONNECT 隧道、代理认证、`NO_PROXY` 与 TLS 穿透,新增一条出站路径(出站清单、`check:egress`、审计都要跟着改);更要命的是走代理时本地 DNS 校验被跳过,**由代理替我们解析**,SSRF 防护就只剩代理的行为——代理(尤其 TUN / 透明代理)往往直通内网,这实际上放松了默认的防内网规则。
- (b) 只改一个判断:只放行 198.18.0.0/15 这一个段;回环、私网、链路本地、云元数据、IPv6 等所有其他规则、跳转重新校验、连接时校验解析结果(防 DNS 重绑定)全部照旧。风险小、可审计、容易测。
- 在 fake-IP 模式下,真实目的地本就由代理解析,本机看到的 198.18.x.x 并不是目标本身;风险只在「没开代理时,恶意域名解析到本机网络里恰好在这个段的设备」,所以开关默认关,并在界面上写明。

实现:`settings.network.allowFakeIp`(布尔,默认 false,存在现有 settings 键值表里,**无迁移**);`web.fetch` 每次执行按 owner 读取,改动立即生效;`isFakeIpAddress` 只判断 198.18.0.0/15。被拦时抛带 `code: 'fake_ip_blocked'` 的错误,消息是中文并说明两种解决办法(开启开关,或在代理软件里把该域名加入 `fake-ip-filter`)。

后续:若有用户需要经代理访问,再单开 PR 做 (a),并在 ADR 里补「走代理时的目标校验」。

## 3. 审批看不见

1. `TaskRun` 增加可选字段 `waitingApproval: { count, expiresAt } | null`:运行中且任务会话里有待批审批时由服务器计算(不入库);任务列表与运行记录显示醒目的「等待批准」与过期时间。
2. 运行记录增加「打开对话」(`sessionId` 早已有);顶部审批面板改成带背景色的横幅与按钮,侧栏「任务」旁与浏览器标签标题显示待批数量。

## 4. 任务预授权入口

服务器早已支持 `policy.allowedTools`。本次补上入口:确认卡与任务卡上的「预授权工具」列出**只读、默认要审批、可预授权**的工具(例如 web.fetch、kb.search、mail.list),勾选后无人值守时可直接运行;说明发信、写文件、推送到渠道等不能预授权的工具每次都要批准。

安全补丁:`web.fetch` 之类声明了 `requireConstraint` 的工具,写进白名单时**必须带约束**(域名),否则等于放行所有网站;服务器返回 400(`task_tool_constraint_required`)。此前该检查只在聊天里「记住」时做,任务白名单没有。

## 5. 不相关的工具调用

无人值守任务的提示里要求「只用和任务相关的工具」;没有授权文件夹时,`fs.*` 不交给模型(`task.withholdToolPrefixes`,模型硬调用也按未知工具处理)。

## 6. #60 审查遗留

cron 校验失败拆成稳定的原因码(`task_cron_fields` / `never` / `interval` / `invalid`)由界面本地化;「上次运行」按任务时区显示;页脚不再显示 `vundefined`;原因码、错误码、提示码在中英文字典里的对应关系由 `i18n-codes.test.ts` 保证。
