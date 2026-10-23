# 邮件学习窗口与维护的原生发送

[English](MAIL-NATIVE-SEND-PROTOTYPE.md)

QQ 新撰写邮件改用代码维护的请求模板 `qq_sendmail_v1`，不再从 DOM 发信中学习模板。回复、抄送、附件、Gmail 和 Outlook 在各自拥有模板之前继续走受管 DOM 流程。下面的学习窗口只保留为请求形状证据，不再学习或确认任何发送。

## 学习窗口

同源 XHR/fetch 与 Outlook Worker/MessagePort 记录请求和响应结构，不记录内容、地址、令牌或响应值。Outlook 发送页在导航前安装 worker 钩子；仅观察原站点消息，不代答或重放。

窗口最长 120 秒、最多 24 条；响应最多 1 MiB、读取最多 5 秒，结构有深度/宽度/节点数限制，每条不超过 8 KiB。只接纳当前窗口发起的请求；迟到回调和跨窗口确认不得复活旧模板。未知键折叠为 dynamic_key。`APP_CLI_MAIL_LEARNING_EVIDENCE=1` 输出这些形状。

## 网络原生发送

原生发送分为与提供方无关的流程（`lib/native-send.mjs`）和提供方模块。提供方模块给出范围、恢复页面、模板版本和明确的拒绝码清单，页面侧在 Reader 上实现 `nativeSendPreflight`、`nativeSendDispatch`、`nativeSendLookup`。QQ 是第一个模块（`lib/qq-native-send.mjs`、`userscripts/lib/qq-sendmail-v1.mjs`）。`lib/native-send-config.mjs` 是发布配置：某提供方是否启用原生发送，以及响应标识是否写入回执的 `provider_message_id`。没有环境变量覆盖，`APP_CLI_MAIL_NATIVE_SEND` 已退役。

范围（QQ v1）：新撰写、单收件人、无抄送、无附件的纯文本邮件，正文不超过 200 KiB；其余走 DOM 流程。v1 邮件从不用 DOM 发信来获取模板，也从不回退到 DOM 发信。

正常路径只有两次页面调用，经主机的受保护代码请求（`runCodeRequest`：固定页面函数加私有 `argument`，邮件内容不进入任何参数列表）：

1. `preflight` 不带邮件内容。复用页面必须仍是准入时的文档 nonce；冷页面在调用内最多等待 5 秒，等 Reader 和登录账号就绪。它检查可见的登录页、账号（不区分大小写）和模板前提（QQ：源 `https://wx.mail.qq.com`、路径 `/home/index`、有 sid、`window.lang` 为短字符串），返回 60 秒内有效的一次性票据。页面、Reader 或前提失败时，先导航回邮箱一次再做一次 preflight，仍失败则报 `email_native_send_unavailable`。这些都在放行发送之前。
2. 执行器放行发送，写入 `dispatching` 日志。`dispatch` 只在这一次携带票据和内容。页面先核对票据（令牌、文档、账号、有效期），不符则返回 `refused_before_request`；然后发起一次 `fetch`，超时 25 秒。

QQ 表单按其自身的 `sendMail`/`k(e)` 和 `post()` 公共参数组装：`func=1`、`mailid=`、QQ 的两个时区公式、`calendar=`、主题、正文、`is_text/is_urgent/is_resume/need_receipt=false`、`from`=已核对的账号、`save_to_send=true`、`separated_copy=false`、`to`、`language`、QQ 的 `r` 公式和 sid。正文按编辑器"粘贴为纯文本"规则转换（首尾空格和连续空格转不换行空格，制表符按 6 列转 EN 空格，每行一个 `<div>`，空行为 `<div><br></div>`）。sid 取法同 QQ 的 `ee()`：先按当前 uin 取 Cookie `xm_muti_sid`/`xm_uin`/`xm_sid`，地址栏 sid 只作兜底；sid 不离开页面。

结果只由响应决定：

- 已接受：请求地址返回 HTTP 200，JSON 不超过 1 MiB，`head.ret` 为 0，`body.mailid` 和 `body.messageid` 有效，响应后账号不变。回执为 `sent`；只有发布开关打开时才带 `provider_message_id`。私有日志保存两个 ID、模板版本、耗时和前端漂移信号。
- 明确拒绝：QQ 列出的 12 个码之一（登录 `-5012 -20002 -20062 -20071 -21021`，参数 `-20011 -21101 -5151 -21501 -21132`，暂时 `-21519 -20003`）。结果为 `status: completed`，数据 `{status: not_sent, not_sent: {kind: provider_rejected, reason, provider_code}}`，绑定原任务；日志原子地把 `dispatching` 替换为 `not_sent`。登录类拒绝使页面失效。
- 待确认：其余情况（网络错误、超时、非 200、非 JSON、缺 ID、账号变化、未列出的码、票据被拒）。单独一次 `lookup` 调用最多查询已发送 12 秒；只有唯一匹配（已知 `messageid` 时按它，否则按 QQ 服务器时间不早于放行时间减 120 秒的行）才成为 `sent`，证据为 `qq_sent_list_v1`；否则任务保持不确定。任何情况都不重发。

结果确定后页面原样停驻：不调用 `setSecrets`、不重置轮次、不清理 DOM、不导航。发送脚本契约声明 `send_admission: in_page`，调用方可凭持久状态准入，不必在发送前再做登录探测。

`APP_CLI_MAIL_SEND_EVIDENCE=1` 输出路径、结果、恢复、原因码、服务商返回码和有界的请求/查询毫秒数，不含邮件内容、sid 或 ID。

## 本地验证与下一关

测试使用合成账号、在 VM 中运行真实 Reader 与模板的页面、模拟的 QQ 服务端和临时日志，不发送邮件。覆盖字段集合与每条取值规则、含夏令时的时区、正文转换、sid 优先级与不一致、每个成功条件的反例、12 个码与清单外的码、登录页与账号不可读的区分、`refused_before_request`、查询的时间下界与唯一性、无 DOM 回退、内容只出现在 dispatch 参数中、任何结果都不重发，以及 `provider_rejected` 回执的对账。

实机验收仍需负责人批准的测试邮件：冷页面第一封、热页面第二封、刷新后第三封；并核对 `mailid` 等于已发送行的 `emailid`、`from` 显示名和正文空白与 DOM 发信一致。通过之后才能打开 `provider_message_id` 开关。历史 unknown 邮件永不重发。
