# 邮件学习窗口与 QQ 重放原型

[English](MAIL-NATIVE-SEND-PROTOTYPE.md)

原型默认关闭。2026-10-22 负责人已授权推送、对应服务升级、work2 部署及新的简短测试邮件；历史 unknown 不重发。一次真实 DOM 发信已确认请求/响应结构，原生重放仍须用独立上线证据验收。

## 学习窗口

同源 XHR/fetch 与 Outlook Worker/MessagePort 记录请求和响应结构，不记录内容、地址、令牌或响应值。Outlook 发送页在导航前安装 worker 钩子；仅观察原站点消息，不代答或重放。

窗口最长 120 秒、最多 24 条；响应最多 1 MiB、读取最多 5 秒，结构有深度/宽度/节点数限制，每条不超过 8 KiB。只接纳当前窗口发起的请求；迟到回调和跨窗口确认不得复活旧模板。未知键折叠为 dynamic_key。`APP_CLI_MAIL_LEARNING_EVIDENCE=1` 输出这些形状。

## QQ 重放

`APP_CLI_MAIL_NATIVE_SEND=qq_mail` 开启单收件人、无抄送/附件的新纯文本 compose 原型。原生消息输入的 JSON 上限 48 KiB，更大消息仍走 DOM。冷页面先正常发信学习；成功且模板确认后，同账户、owner、scope、凭据代次和 binding 的独立发送页最多保留 15 分钟。停驻前清空消息私密槽位、Reader 记录及应用自己的 DOM 引用。下次租约必须验证同一 document nonce 和账户，并在加载新私密槽位前更新租约权限。

真实发送为 POST `/send/sendmail`、`func=1`、恰好 18 个字段；五个可选模式值为字符串 false，save_to_send=true。同路径 func=2 是自动存草稿，不能学习成发送模板。未知/重复字段、bcc、附件、回复、续草稿、日历、回执、发送人不符或重定向均拒绝。

DOM 发送通过既有已发送页面证明后，还要独立查询 Sent，将响应 body.messageid 与页面已证明的 emailid 关联，并精确核对主题和收发件人。旧收件人、正文、主题和草稿 ID 随即清空，session 只在页面内存。

就绪模板自 DOM 确认起有效 15 分钟；每次被证明 sent 的重放在同一页面再续期 15 分钟。以下情况失效：过期、换账户、页面重载或销毁（模板只在页面内存；document nonce 已变的复用发送页会重新导航并走 DOM 发信）、发出前 Sent 读取失败，以及任何未被证明 sent 的重放（含服务端拒绝）。学习窗口（含 QQ 标记已读）不清除模板；新观察并确认的 DOM 发送会替换它。

释放执行授权、写 dispatching 栅栏之前先做前置检查：模板就绪、校验新邮件，并在页面会话上读取新的 Sent 基线，返回绑定该邮件的一次性票据（5 分钟有效；授权释放期间模板到期不会使其失效）。任何拒绝（含 Sent 读取失败或被服务端拒绝）对原生路径即为 not_sent：未发出、未占用 dispatch，同一次发信继续走 DOM。只有票据能发信。

随后产品侧释放授权并持久化 dispatching 栅栏，Reader 发信一次。新主题/正文/收件人替换模板，旧 mailid 清空，重定向禁用；请求与核对合计不超过 28 秒，低于宿主 30 秒的页面调用预算。发出后只读轮询 Sent：1 秒后首读，之后每 750 毫秒一次，最后一次恰在 12 秒，出现即返回。实测 QQ 在受理 4.2 秒后列出重放邮件，因此仅 12 秒后仍未出现才判 unknown。不回退 DOM，不自动重发。

成功必须同时满足：响应 head.ret=0 和有效 body.messageid；独立 POST `/list/maillist`（folder 3，page 0，size 50）有且仅有一条同 messageid 的新记录；dirid=3、emailid 有效且不在基线；主题、唯一发件人及唯一收件人精确匹配。公开回执 provider_message_id 使用 emailid，私有发送 journal 保存两个标识及关联证明。不存在、歧义、旧记录、错账户/主题/收件人或响应丢失都保持 unknown。reconcile 只读取原回执。

`APP_CLI_MAIL_SEND_EVIDENCE=1` 记录 DOM/native 路径、总耗时、发送请求耗时、Sent 核对耗时、各宿主调用次数与耗时，以及前置检查 not_sent 的原因和 DOM 回退，不记录邮件值或标识。

## 验证

测试覆盖序列化 Reader、worker、脱敏、窗口关联、模板过期、账户/文档漂移、自动存草稿排除、并发单次消费、不同标识命名空间、独立 Sent 字段/唯一性/新鲜性、授权拒绝、私密槽位清理失败与重启/reconcile 不重发。

真实 DOM 基线 QQ→Outlook：完整调用 64.935 秒，发送请求 367 毫秒；发送响应后 1.209 秒取得匹配 Sent 标识，稍后的独立 search 再核对主题及收发件人。92 条历史 unknown 保持不变。该基线不代表原生重放已经上线或达到目标时延；配对发行和后续新信另行验收。回复、附件、Outlook/Gmail 重放不在本原型范围。

macOS 使用 TMPDIR=/private/tmp、Node 26、Python 3.11 运行测试，避免既有临时目录符号链接问题。完整 runtime 测试串行执行并启用 recovery 用例。
