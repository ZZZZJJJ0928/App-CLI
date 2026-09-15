# App-CLI

**把应用能力转化为 Agent 可以直接调用的命令。**

[English](README.md) · [架构](docs/ARCHITECTURE.md) · [跨平台技术方案](docs/TECHNICAL-OPTIONS.md) · [适配器开发](docs/ADAPTER-DEVELOPMENT.md) · [路线图](docs/ROADMAP.md)

开发者分析目标 App，提炼并验证它的业务能力，形成可版本化的 App-CLI。Agent 通过简单业务参数调用命令，获得结构化结果；应用状态、内部方法和页面差异由适配器处理。开发阶段持续维护，业务阶段重复使用已验证的能力。

这是独立的跨平台项目，目标覆盖 Windows、macOS、Linux、Android 和 iOS。应用 API/SDK、已有 CLI、IPC、系统脚本、浏览器自动化、辅助功能、UI 测试驱动、动态插桩、文件格式、视觉识别和已有执行运行时都可以成为适配方式。核心框架不依赖特定平台或工具；部分后端内部仍需要交互桌面或设备会话。

GUI 事件背后的函数是有价值的分析入口。将它变成可靠命令，还需要验证线程、应用状态、会话、授权、异步结果和副作用。项目不会仅凭函数返回就宣称业务已完成。

## 当前可用

当前 `0.2` 提供可安装 CLI、显式适配器注册、Manifest 与 JSON Schema、参数及输出校验、通用运行时协议和任务结果契约。`calculator` 直接调用业务函数，`calculator-cli` 调用计算器 CLI，`calculator-runtime` 通过 JSON 协议调用独立的自有计算器执行进程；可选 Tk GUI 也复用业务函数。所有示例与测试均可独立运行。Manifest 版本仍为 `1.0`，支持 13 种接入声明；声明类型不等于已交付对应后端。

```sh
python -m venv .venv
# POSIX：. .venv/bin/activate
# PowerShell：.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"

app-cli apps
app-cli describe calculator
app-cli schema calculator add
app-cli calculator add --a 2 --b 3
app-cli calculator multiply --input '{"a":6,"b":7}'
app-cli calculator-cli multiply --a 6 --b 7
app-cli calculator-runtime multiply --a 6 --b 7
```

也可以用 `python -m app_cli`。JSON 引号需按所用 shell 转义，命名参数更便于跨 shell 调用。

```json
{"protocol_version":"1.0","ok":true,"app":"calculator","command":"add","data":{"value":5}}
```

计算器参数为 ±1,000,000 范围内的整数。`--input` 与命名参数不能混用；帮助和版本为普通文本，其余命令输出单行 JSON。退出码：成功 `0`，参数/Manifest 错误 `2`，执行失败或未支持能力 `1`，中断 `130`。

可选开发 GUI：`python examples/calculator/gui.py`，需要当前 Python 安装支持 Tk。该示例展示自有应用的函数复用，不代表已经完成第三方 GUI 或 Frida 附加验证。

`calculator-cli` 固定调用当前 Python 环境中已安装的 App-CLI，带执行超时、子进程响应校验和结构化错误。它验证 CLI 接入方式，尚未证明第三方应用覆盖；使用上述虚拟环境安装后即可运行。实现说明见[子进程参考](docs/ADAPTER-DEVELOPMENT.md#cli-subprocess-reference)。

通用 `RuntimeAdapter` 使用开发者显式注册的 Manifest 和固定执行命令，通过标准输入传递 JSON 业务参数。`TaskResult` 保留任务状态和公开任务 ID；执行中、等待确认、不确定、失败、取消、受阻等状态均返回 `ok: false` 和退出码 `1`。只有任务完成且输出满足业务合同才返回成功，既有同步适配器的返回格式保持兼容。接口与独立示例见[运行时接入](docs/RUNTIME.md)。计算器运行时示例是同步、无持久状态的协议验证。

当前没有交付 Android/iOS/第三方桌面应用适配器，也没有自动后端选路、远程执行或 MCP 服务。写操作的授权、幂等和持久任务协调尚待实现，mutation 命令仍在适配器调用前被拒绝。Windows/macOS/Linux 的 CI 矩阵已经配置，实际验证范围单独记录在[验收记录](docs/VALIDATION.md)。

## 如何选择技术方案

先调查应用提供的 API/SDK、CLI、IPC 和脚本契约，再根据业务覆盖、运行条件与结果可验证性比较浏览器、辅助功能、测试驱动、插桩和视觉方案。同一个业务命令可以在不同平台使用不同实现。

[跨平台技术方案](docs/TECHNICAL-OPTIONS.md) 提供技术矩阵、Windows/macOS/Linux/Android/iOS 的候选入口、官方来源和最小验收实验。调用端、执行主机和目标平台分别记录；当前注册表显式选择适配器，尚无失败后自动切换后端的机制。

## 命令设计

Agent 参数应是关键词、商品、文档、规格等业务概念，内部类名、控件 ID 和脚本源码由适配层维护。社区按应用逐项增加经过验证的能力，共同维护兼容性与结果可靠性。

## 参与开发

```sh
python -W error::ResourceWarning -m unittest discover -s tests -v
python scripts/check_public_tree.py
python -m build
```

贡献前阅读 [CONTRIBUTING](CONTRIBUTING.md) 和 [适配器开发规范](docs/ADAPTER-DEVELOPMENT.md)。提交中说明准确版本、业务参数、前置状态、结果证据及失败处理；未实测部分明确标注。账号、令牌、原始界面、设备标识及第三方应用二进制保留在私有目录。

适配器是被显式信任的本地代码，当前不是沙箱，也不自动下载或执行第三方插件。安全问题按 [SECURITY](SECURITY.md) 处理。

项目采用 [MIT 许可证](LICENSE)。第三方应用与工具保留各自的许可和访问要求。
