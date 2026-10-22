# 应用运行时与邮件维护

[English](APPLICATION-RUNTIME.md) · [生命周期](LIFECYCLE.zh-CN.md) · [验证记录](VALIDATION.md)

收信页由监听和纯网络查询、原文抓取、线程清单复用，严格绑定 owner、账户、范围、凭据代次和 binding。
连接检查只能通过凭据匹配的当前监听加入；未绑定检查仍使用独立任务页。发信和标记已读始终独立。
每次收信任务在执行前后校验文档、账户并清理 Reader 临时状态。持续续租的监听维持常驻页；
停止监听后，已开始的读取可以完成，随后关闭页面，不再重新停泊。租约到期、撤销和清理围栏继续生效。
周期性授权维护按有界批次让出事件循环，避免索引目录增长阻塞 Host。

Outlook 在页面内保留首次消费的原生搜索请求（URL、含请求头的 init、改写后的请求体），之后的收信区间用页面自身的 fetch 绑定重放；401/403 或响应形状变化时丢弃模板，下一轮只通过搜索框重新学习一次。监听通知可携带最多 16 个取自服务商信封的候选目标（QQ `mid`、Outlook ItemId 与收信时间），handler 重新校验，且只作为合格证据。发送或 QQ 标记已读布置期间，Reader 记录网页客户端自身同源请求的形状（方法、脱敏路径、参数与请求体键名、状态、服务商结果码，绝不记录值）；`APP_CLI_MAIL_LEARNING_EVIDENCE=1` 时在操作后把形状写到 stderr。

QQ 已读确认通过新鲜、有界的原生搜索，精确绑定账户、邮件、选择标识、文件夹及收信时间，
不使用缓存已读标志或页面偶然出现的列表 URL。最多点击一次精确可见的邮件行，随后只有独立的
服务端元数据才能确认已读。中断或结果未知的已读 journal，在后续调用中只允许只读确认，
不再放行写入；准备和已放行尝试分别记录，恢复不改动已抓取原文或清单。

维护 fork 的发行身份为 `0.3.0-sparkclaw.32`；Python 版本为 `0.3.0+sparkclaw.32`，可选 Node 包为 `@infinimesh/app-cli-runtime@0.3.0-sparkclaw.32`。这不是上游发行。邮件是首批应用，公共 Registry 不依赖 Node、邮件或浏览器。

## 调用与维护边界

SparkClaw 产品准入 → ProductClient → `app-cli --machine` → `Registry.control` → RuntimeAdapter 3.0 → 固定传输客户端 → owner-local Executor → 应用 handler → 签名 BrowserHostPort → SparkClaw 任务页 / Bridge / Desktop。

`app-cli --machine --session` 让入口常驻：只校验一次发行并构建一次 Registry，之后每行一个紧凑 JSON 请求，按一次性入口的方式逐行应答。ProductClient 维持小型会话池（每个进程同时只有一个请求），入口未返回会话问候时退回一次性调用。runtime adapter 直接与 executor socket 交换原有的 EOF 分隔消息（`"executor_transport": "process"` 恢复随包客户端程序）；状态等待自适应轮询。线上消息、授权与准入不变。

Python Registry 是唯一公共能力目录和准入点；Node binding 只是内部执行映射。`APP_CLI_CONFIG` 指向 owner-private 的可信部署配置，不接受业务参数指定模块、程序或服务。未配置时原生/CLI/Runtime v1 计算器独立可用，默认拒绝写操作。

`applications/mail` 维护 QQ、Gmail、Outlook 命令、选择器、账户/文档校验、等待策略、Reader 源码、通知规则和发送 journal。`applications/mail/build-bindings.mjs` 生成三个 Manifest 和 binding。MailboxClient 兼容产品回执，但所有操作仍经 Python Registry。SparkClaw 保留审批、同步入库、UI 与通用浏览器资源所有权。应用不导入 SparkClaw 源码或另开浏览器。页内 `SparkClawMailReader` ABI 保留以兼容既有页面，不代表源码仍归 SparkClaw。迁入代码、测试和衍生资产保留 Apache-2.0 及源 commit 归属；原核心保持 MIT。

## 新增控制应用

1. 在 `applications/<name>` 实现后端、Manifest 1.0 和输入/输出 Schema。写操作必须注册审核过的 LifecycleAdapter；原生/CLI 后端无需 Node。
2. 本运行时使用符合[执行绑定 Schema](../schemas/execution-binding-v1.schema.json)的 binding、确定性 Manifest 摘要和显式 handler 映射，由可信 assembly 注册。
3. 声明所需 Host 方法、origin、导航前资产、资源通道、效果和超时。非浏览器后端不需 Host。非邮件浏览器与原生可变计数器夹具验证两种路径。
4. 补齐意图/owner 绑定、防重、取消、恢复和结果证据，重建成套发行并更新消费者投影。复用既有后端和 Host 能力时，不需修改 Registry 或 SparkClaw 调度器。

## 状态与固定边界

handler 的 completed 结果必须先通过输出校验，并再次检查执行授权、取消和截止时间。
Executor 等待 Host 清理尝试结束后才发布终态回执并接受 ACK。若清理失败，保留已验证的
业务完成结果，并在同一账本事务记录 `host_cleanup_failed` 诊断事件；Host 资源退休与
清理围栏继续生效，不重试供应商动作。清理期间后来发生的停止不抹去已验证结果。
无效或缺少证明的输出仍按原有失败/未知语义处理；终态提交前崩溃，仍需显式对账读取原始
持久 journal。

Python 启动器持有继承的 POSIX flock。SQLite WAL/FULL 在效果发生前持久提交主体、owner、request key、意图、task、效果围栏和事件。每次启动增加 execution_epoch；原子 `authority.json` 高水位同时记录 epoch 与提交序列，阻止缺失或旧账本（含同一 epoch 的旧快照）启动。重启将未完成读取置 blocked、有副作用任务置 uncertain，并发 gap。发送对账只读原 journal，不再次点击发送。Bridge 凭据变化后，journal 对账保留原任务资源绑定的授权，不领浏览器页。产品索引存在但 lookup 无法确认时不再次提交。ledger 2 在首次启动时把 ledger 1 原地迁入已关闭的 legacy 代次；重启时作废未放行的发送保留（任务仍可恢复），已放行的发送置为 uncertain。可选独立进度锚（部署配置 `anchor`：`none`，或经 Unix socket/URL 与 bearer token 的 `http`）确认每次发送放行并检测整组回滚。用户可为结果未知的发送结案，结案从不重新发送。后台单写者仅在请求代次关闭且交付义务满足后回收终态任务（读取结果 ACK 后 1 小时或无 ACK 1 天；已发送在 ACK 加回执保留期后；已结案发送立即）；legacy 代次行保留。准入按账本、WAL 与授权的实测占用及恢复预留判断。不声称远端 exactly-once。

| 边界 | 冻结值 |
| --- | --- |
| 公共请求 / 参数 / 响应 | 2 MiB / 1.5 MiB / 1 MiB |
| 传输 / 产品控制预算 | 15 秒 / 25 秒 |
| 邮件采集业务预算 | 最长 1,800 秒，与 RPC 独立 |
| watch 授权 / 提前续期 | 300 秒 / 60 秒 |
| 心跳 / 活动租约 | 10 秒 / 最长 30 秒 |
| watch 失联恢复 | 60 秒，耗尽后 blocked + gap |
| 读取页空闲保留 | 最长 30 分钟，无动作权限 |
| 大型宿主结果 | owner-private 的哈希校验引用，最多 16 MiB |
| 事件保留 | 每 task 最近 1,000 条，过期 cursor 显示 gap |
| 新任务容量门槛 | 不限制累计任务条数；数据库 512 MiB，另按 `storage.budget_bytes`（占位 2 GiB）及恢复预留判断实测占用，压力时返回 `STORAGE_PRESSURE` |
| 产品任务访问授权 | 30 天，与执行授权独立 |

显式正整数 `maxTasks` 可启用任务条数门，零表示不计数。旧数据库无需迁移，完整请求历史继续保留。

容量达到门槛后拒绝新任务并返回 `LEDGER_CAPACITY_EXCEEDED`，保留既有查询、防重和冲突检测。该门槛不是硬文件系统配额：活跃结果、事件、WAL、授权与邮件文件仍需额外磁盘空间。不得通过删除账本/授权索引恢复服务；扩容或归档需维护变更且保留请求历史。

Host generation 与 epoch 隔离旧调用。共享页的 read/watch 各有活动租约；实际 CLI daemon 监视租约并使用单调时钟到期，Controller 丢失后仍可停用。Reader/账户校验失败使页面失效，清理失败禁止复用。撤销 watch 不关闭有效 read。私有结果引用校验 owner、路径、大小和哈希。[Host 消息 Schema](../schemas/browser-host-v1.schema.json)固定签名结构。

## 构建与成套切换

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
npm ci --prefix runtimes/browser --ignore-scripts
.venv/bin/python -W error::ResourceWarning -m unittest discover -s tests -v
npm test --prefix runtimes/browser
.venv/bin/python release/build.py
```

最终构建前提交审核后的源代码。`dist/release/release.json` 记录源 commit、Python 源摘要、wheel/npm/固定 Python 依赖摘要；运行时清单覆盖源码、Schema、Manifest、binding 和资产，wheel 嵌入其摘要。不得拼接不同构建的产物。SparkClaw 整组 vendor，并同时验证自身实际安装的客户端包和执行服务 runtime。

`python -m app_cli.executor_service /absolute/private/config.json` 启动 owner-local 服务。配置固定 Node/assembly/socket、binding 摘要与私有 key/grants 路径。可信产品签发不可变 `{grant, resource, mac}`，Python、Executor、Host 分别校验；key、登录态、用户内容不进入发行。

准备全部产物后排空 Executor 和 Host，再切换匹配的消费者、wheel、npm 与 Reader/preload 投影；握手核对实际发行和 binding。回退恢复整组兼容当前 ledger 版本的产物；ledger 1 发行拒绝已迁移的 ledger 2 目录，激活后只能使用兼容 ledger 2 的包，禁止恢复旧执行证据。保留原 state、请求索引、journal，epoch 继续递增。未知状态版本或缺失权威记录阻止启动。SparkClaw 安装器与隔离发行验证脚本覆盖这些步骤。

## 验证边界

本机 macOS、Python 3.11、Node 26 下，Python 86 项通过，运行时/供应商 457 项通过、2 项跳过。仓库外安装和两组兼容制品验证了篡改拒绝、混版拒绝、运行中禁止切换和持久状态回退。SparkClaw 另以安装后的 Python Registry、常驻 Executor、实际隔离 Electron 任务页验证非邮件命令，同时回归普通 MCP/CLI 和个人页隔离。

供应商测试使用合成邮件，覆盖账户/文档、发送完成证据、原件处理和 watch 契约。自动化测试不等于 QQ/Gmail/Outlook 实际收发验收；后者属于配套部署的独立验收。未宣称云端矩阵或非 POSIX 生命周期传输通过。

## 账号身份与投递地址

邮件发现继续将 `account_address` 作为已验证的稳定命名空间，用于 Reader
身份校验、抓取记录、邮件标识、发送日志与账号绑定；它不一定能够接收 SMTP
邮件。发现结果可另外返回 `delivery_address`（最多320字符）和
`account_aliases`（1至100个无重复的小写地址）；两者一起返回或一起省略，投递地址必须包含在别名中。
范围发现通过 `collect_page.discovery` 携带相同字段，页面顶层不重复身份。
这些观测变化时，调用方必须保留邮箱ID和已有邮件，并在构造回复全部收件人
时排除所有已验证别名。

QQ Mail、Gmail使用原来已验证的登录账号承担两种角色。Gmail只读取页头唯一
可见的账号按钮，并核验其Google Accounts退出选项目标；账号标签不依赖界面
语言，属性冲突或账号歧义直接拒绝。生成的Reader与原生发信回退共用这一提取，
保留预期账号校验，账号切换不能覆盖既有绑定。登录检查仍使用原有写信按钮
就绪信号，可选账号提示不作为身份绑定。邮件正文、账号切换列表及推测的发件人
均不作为身份依据。对于已验证的消费版
Outlook页面，适配器读取当前原生 `UserMailbox` 配置，调用其原生默认SMTP
发件地址和别名选择，要求每个候选属于同一邮箱的代理地址，排除原生判定的
内部路由地址，并确认观测期间邮箱没有变化。它不会根据收发邮件头推断身份
或别名，不改写内部MSA地址，也不选择其他账号。原生模块或版本不合格时省略
投递元数据，绝不会将内部身份当作投递地址；省略也不能证明历史投递地址
仍然有效。

该结果是地址选择证据，不是投递保证；收件策略、服务健康和邮箱状态仍可能
拒收。真实发送及接收验收与登录检查、合成测试保持独立。

本地响应/worker 学习及默认关闭的 QQ 重放实验见[原型说明](MAIL-NATIVE-SEND-PROTOTYPE.zh-CN.md)。
