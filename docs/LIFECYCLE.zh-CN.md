# 生命周期契约 2.0

[English](LIFECYCLE.md)

本 fork 在现有 Registry / Adapter 上扩展生命周期能力。Runtime 1.0 和旧 CLI 输出保持兼容；公共消息定义见[生命周期 Schema](../schemas/lifecycle-v2.schema.json)，测试逐字节校验包内副本。可选[应用运行时](APPLICATION-RUNTIME.zh-CN.md)说明完整迁移和独立验证边界。

显式审核注册绑定应用 Manifest 摘要、实现身份、一致性证据、支持操作和可续期命令。仅实现 `invoke_lifecycle(request, context)` 不会放开写操作；Registry 同时要求审核注册和注入的可信授权提供方。业务参数不能携带模块导入、服务地址、执行程序或自报批准。RuntimeAdapter 2.0 是传输实现，原生适配器可实现同一个生命周期接口。

`app-cli --machine` 从 stdin 接收一条 UTF-8 JSON 请求，不可混用旧选项。请求上限 2 MiB，序列化业务参数上限 1.5 MiB，响应上限 1 MiB。拒绝重复键、非有限数、孤立代理字符和 JavaScript 安全整数范围外的整数。旧 CLI 的数值行为不变；底层异常不得泄漏到公开错误。

操作包括 invoke、lookup、status、cancel、resume、renew、events、reconcile，均携带 app、command 和不透明 authorization_ref。invoke 携带稳定 request_key、arguments 及 deadline_ms；只有显式可续期命令可省略总 deadline。lookup 使用原 request_key，其余操作使用原 task_id；events 还要求 cursor，limit 默认 100、最高 200。deadline_ms 为 UTC 毫秒时间戳，不是传输超时。

可信提供方解析 principal、owner、精确 app/command、request_key、意图摘要、允许操作/效果、最大 deadline、独立的访问与执行有效期；这些不能由调用者 JSON 自报。执行授权过期后，任务访问授权仍有效时可以查询、取消或读取事件；invoke/resume/renew/reconcile 要求执行授权仍有效。具体后端必须再次核验授权，并把控制操作绑定到原持久任务。

意图摘要采用 SHA-256，输入为 app、command、request_key、arguments 及存在时的 deadline_ms 组成的对象。确定性编码每个节点为“类型标签 + ASCII 十进制负载字节数 + 冒号 + 负载”：n 为 null/空负载，b 为布尔值 0/1，s 为 UTF-8 字符串，d 为八字节大端 IEEE-754 数值（负零归一为零），a 为各元素编码拼接，o 为按键 UTF-8 字节排序的键/值编码拼接。整数范围为正负 9007199254740991；等值整数和浮点数使用同一编码，避免语言间 JSON 浮点格式差异。

有效响应回显 version、operation、app、command；invoke/lookup 还回显 request_key。kind=task 使用原有八态和任务 ID，只有 completed 携带通过原命令输出 Schema 的 data。kind=ack 仅确认取消请求，不代表任务完成；kind=events 提供有界事件页、cursor 和显式 gap。lookup 返回原任务，或 kind=lookup 的 not_found/unresolved；只有完整权威账本能证明 not_found，传输失败不能。任何操作都不自动重试或创建第二个业务意图。

机器级失败使用 kind=error、脱敏错误码/消息及可用时的原 request_key/任务元数据，与合法业务状态不同。合法控制响应退出 0，即使任务仍 pending 或业务 failed；输入错误退出 2、执行/传输错误退出 1、中断退出 130。旧 execute API 的未完成状态仍表现为原有结构化错误。

后端拥有持久受理、意图绑定、恢复、目标串行化、执行代次、取消和独立对账，不能把传输 ACK 当完成。失效租约不可复活；renew 只用于活跃可续期任务，resume 只恢复原 blocked/waiting 任务。这些转换须由具体后端独立验收，消息能通过 Schema 不等于后端已实现。

## 实现范围与验证边界

当前核心实现机器解析、审核注册、可信授权准入和响应/业务输出校验。RuntimeAdapter 2.0 向固定程序发起单次请求，读取过程中限制 stdout，客户端预算最高 30 秒，完成/失败后清理 POSIX 进程组。v2 传输目前只在 POSIX 启用；v1 和原生适配器保留原可移植性。这是受信任客户端的传输，不是防止恶意进程逃逸的沙箱。

默认 CLI 不含生命周期注册或授权解析器，调用时明确拒绝。集成方构造带 `lifecycle=[...]` 和可信 `authorization` 的 Registry，调用 `Registry.control()`，或向 `cli.main` 注入该 Registry。没有自动模块加载、用户可选执行程序或通用 --allow-write 开关。

原生和 Runtime 独立夹具在 SQLite 事务中同时保存合成计数器结果与原任务，覆盖并发重放、意图漂移、执行/访问授权分别过期、账户隔离、结果校验和持久提交后丢失回包。夹具不作为生产邮件适配器发布。可选应用运行时已实现 Node Executor、execution binding / BrowserHostPort Schema、执行权交接、watch 续期、供应商实现及 SparkClaw 消费，并分别提供运行时、宿主和产品集成测试。APP_CLI_CONFIG 显式装配签名部署；未设置时保留原参考命令。计数器测试不替代真实邮箱验收。
