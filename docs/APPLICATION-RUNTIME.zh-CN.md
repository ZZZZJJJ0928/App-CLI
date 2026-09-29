# 应用运行时与邮件维护

[English](APPLICATION-RUNTIME.md) · [生命周期](LIFECYCLE.zh-CN.md) · [验证记录](VALIDATION.md)

维护 fork 的分支为 `codex/sparkclaw-email`，发行身份为 `0.3.0-sparkclaw.1`；Python 版本为 `0.3.0+sparkclaw.1`，可选 Node 包为 `@infinimesh/app-cli-runtime@0.3.0-sparkclaw.1`。这不是上游发行。邮件是首批应用，公共 Registry 不依赖 Node、邮件或浏览器。

## 调用与维护边界

SparkClaw 产品准入 → ProductClient → `app-cli --machine` → `Registry.control` → RuntimeAdapter 2.0 → 固定传输客户端 → owner-local Executor → 应用 handler → 签名 BrowserHostPort → SparkClaw 任务页 / Bridge / Desktop。

Python Registry 是唯一公共能力目录和准入点；Node binding 只是内部执行映射。`APP_CLI_CONFIG` 指向 owner-private 的可信部署配置，不接受业务参数指定模块、程序或服务。未配置时原生/CLI/Runtime v1 计算器独立可用，默认拒绝写操作。

`applications/mail` 维护 QQ、Gmail、Outlook 命令、选择器、账户/文档校验、等待策略、Reader 源码、通知规则和发送 journal。`applications/mail/build-bindings.mjs` 生成三个 Manifest 和 binding。MailboxClient 兼容产品回执，但所有操作仍经 Python Registry。SparkClaw 保留审批、同步入库、UI 与通用浏览器资源所有权。应用不导入 SparkClaw 源码或另开浏览器。页内 `SparkClawMailReader` ABI 保留以兼容既有页面，不代表源码仍归 SparkClaw。迁入代码、测试和衍生资产保留 Apache-2.0 及源 commit 归属；原核心保持 MIT。

## 新增控制应用

1. 在 `applications/<name>` 实现后端、Manifest 1.0 和输入/输出 Schema。写操作必须注册审核过的 LifecycleAdapter；原生/CLI 后端无需 Node。
2. 本运行时使用符合[执行绑定 Schema](../schemas/execution-binding-v1.schema.json)的 binding、确定性 Manifest 摘要和显式 handler 映射，由可信 assembly 注册。
3. 声明所需 Host 方法、origin、导航前资产、资源通道、效果和超时。非浏览器后端不需 Host。非邮件浏览器与原生可变计数器夹具验证两种路径。
4. 补齐意图/owner 绑定、防重、取消、恢复和结果证据，重建成套发行并更新消费者投影。复用既有后端和 Host 能力时，不需修改 Registry 或 SparkClaw 调度器。

## 状态与固定边界

Python 启动器持有继承的 POSIX flock。SQLite WAL/FULL 在效果发生前持久提交主体、owner、request key、意图、task、效果围栏和事件。每次启动增加 execution_epoch；原子 `authority.json` 高水位同时记录 epoch 与提交序列，阻止缺失或旧账本（含同一 epoch 的旧快照）启动。重启将未完成读取置 blocked、有副作用任务置 uncertain，并发 gap。发送对账只读原 journal，不再次点击发送。产品索引存在但 lookup 无法确认时不再次 invoke；不声称远端 exactly-once。

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
| 新任务容量门槛 | 10,000 task 或已分配数据加新请求达到 512 MiB |
| 产品任务访问授权 | 30 天，与执行授权独立 |

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

准备全部产物后排空 Executor 和 Host，再切换匹配的消费者、wheel、npm 与 Reader/preload 投影；握手核对实际发行和 binding。回退恢复整组兼容 ledger v1 的产物，保留原 state、请求索引、journal，epoch 继续递增。未知状态版本或缺失权威记录阻止启动。SparkClaw 安装器与隔离发行验证脚本覆盖这些步骤。

## 验证边界

本机 Python 86 项、运行时/供应商 273 项测试通过。仓库外安装和两组兼容制品验证了篡改拒绝、混版拒绝、运行中禁止切换和持久状态回退。SparkClaw 另以安装后的 Python Registry、常驻 Executor、实际隔离 Electron 任务页验证非邮件命令，同时回归普通 MCP/CLI 和个人页隔离。

供应商测试使用合成邮件，覆盖账户/文档、发送完成证据、原件处理和 watch 契约。本次最终验证不发送真实邮件、不操作真实 QQ/Gmail/Outlook 账号；三家实机业务验收及生产激活留用户最终验收。未宣称云端矩阵或非 POSIX 生命周期传输通过。
