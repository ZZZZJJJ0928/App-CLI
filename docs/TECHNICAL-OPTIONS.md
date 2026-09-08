# 跨平台技术方案与选型

App-CLI 的跨平台边界是统一的业务命令、参数、结果和失败语义。适配器根据应用实际提供的接口选择实现；一个命令在不同平台可以有不同后端。Frida 是其中一种动态插桩工具。

资料核对日期：2026-09-08。下文的选型顺序和实施优先级是本项目的工程建议；链接用于说明各技术的能力与前提，不代表 App-CLI 已经适配这些工具或应用。

## 当前交付范围

| 层次 | 当前状态 |
| --- | --- |
| 业务契约 | 参数及结果校验、显式注册、结构化错误；输出协议版本为 `1.0` |
| 接入方式声明 | Manifest 版本为 `1.0`，支持下表 13 个 `kind` |
| 可运行后端 | `calculator` 直接调用自有函数；`calculator-cli` 通过真实子进程调用同一个自有计算器 CLI |
| 平台证据 | 本地验证范围见[验收记录](VALIDATION.md)；Windows/Linux CI 配置不等于已通过验证 |
| 后续能力 | 其他应用后端、自动选路、环境诊断、远程执行和写操作协调均待实现 |

声明 `kind` 不会安装工具、加载插件或自动获得对应能力。当前核心只执行 `read_only` 命令；需要启动 GUI、切换页面、写文件或改变远程状态的完整流程，必须如实评估其副作用。

## 技术路线矩阵

维护成本为相同业务范围下的相对判断，最终取决于接口稳定性、应用版本和验证条件。

| `adapter.kind` | 可选实现 | 适合的业务入口 | 主要前提与维护成本 | 仓库实现 |
| --- | --- | --- | --- | --- |
| `native-api` | 应用 SDK、共享库、自有业务函数、官方扩展 API | 结构化查询、文档模型、计算能力 | 必须有可调用契约；维护绑定与 ABI，通常较低 | 自有计算器 |
| `http-api` | 应用公开或授权提供的 HTTP API | 搜索、状态查询、服务端任务 | 认证、分页、配额、接口版本；中低 | 待实现 |
| `cli` | 应用已有 CLI、受控子进程 | 已有命令的业务封装 | 固定程序、结构化输出、版本与超时；中低 | 自有计算器 CLI |
| `ipc` | COM Automation、D-Bus、Binder/AIDL、应用声明的本地 RPC | 已公开的对象、方法、事件 | 应用需主动暴露接口；会话、线程、权限、协议版本；中 | 待实现 |
| `scripting` | AppleScript、Scripting Bridge、Shortcuts、应用内脚本 | 应用声明的动作和脚本对象 | 脚本字典或已安装动作；交互提示及权限；中 | 待实现 |
| `browser` | Playwright、WebDriver、受控 CDP 连接 | Web 应用、可调试的 WebView/Electron 界面 | 浏览器引擎、DOM、会话和调试入口；中 | 待实现 |
| `accessibility` | Windows UIA、macOS AX、Linux AT-SPI | 有语义树和可访问操作的桌面应用 | 控件覆盖、交互桌面、权限、稳定定位；中高 | 待实现 |
| `ui-test` | Android UI Automator、Appium 平台驱动、XCUITest/WDA | 可部署测试运行环境的移动端或桌面目标 | 主机工具链、设备会话、驱动版本；中高 | 待实现 |
| `instrumentation` | Frida、JVMTI、受控调试器接口 | 已验证的内部方法或运行时观测 | 进程访问、签名/构建条件、ABI、线程、版本漂移；高 | 待实现 |
| `frida` | Frida 专用声明 | 明确使用 Frida 的插桩适配器 | 也可用通用 `instrumentation` 描述插桩方式 | 待实现 |
| `file` | 官方文档格式、导出文件、应用明确支持的数据快照 | 离线检索、文档元数据 | 格式版本、快照一致性和数据新鲜度；中低 | 待实现 |
| `vision` | OCR、OpenCV 模板匹配、视觉模型辅助定位 | 缺乏可用语义接口的画布或远程画面 | 图像来源、缩放/主题变化、置信度与独立结果验证；高 | 待实现 |
| `runtime` | 现有执行服务或设备运行环境 | 复用已维护的远程执行能力 | 主机与目标映射、认证、会话、取消和状态查询；取决于服务 | 待实现 |

`kind` 描述适配器的主要接入方式，不是互斥的底层协议分类。例如 AppleScript 使用 Apple events，Appium 使用驱动协议；一个适配器也可以组合多种技术。Manifest 当前只表达一个主类型，组合策略需要在适配器文档中说明。

## 各平台可落地的入口

| 目标 | 优先调查的接口 | 界面与测试方案 | 必须单独确认的执行条件 |
| --- | --- | --- | --- |
| Windows 应用 | 应用 SDK/CLI、COM Automation、本地 RPC | UI Automation；经验证的应用专用测试驱动 | Windows 执行主机、用户会话、进程位数、权限和线程模型 |
| macOS 应用 | 应用 SDK/CLI、AppleScript/Scripting Bridge、Shortcuts | AX 辅助功能接口 | 脚本支持、Automation/Accessibility 授权、是否会弹出交互窗口 |
| Linux 应用 | 应用 CLI、D-Bus、公开本地服务 | AT-SPI；必要时经桌面 portal 提供的远程桌面能力 | 会话总线、桌面环境、X11/Wayland、portal 后端和用户授予的设备能力 |
| Android 应用 | 导出的 Intent、ContentProvider、已开放的 Binder/AIDL 服务 | UI Automator、Appium UiAutomator2；适用时其他测试驱动 | 组件导出及权限、设备授权、测试运行环境、主机 SDK 和目标版本 |
| iOS 应用 | 应用主动提供的 App Intents、Shortcuts、公开链接或服务 API | Appium XCUITest/WDA；满足条件时的受控插桩 | 动作是否公开、真实设备/模拟器、签名、WDA 部署、主机工具链 |
| Web/Electron | 服务 API、浏览器语义接口 | Playwright、WebDriver；可用时 CDP/Electron 专用支持 | 引擎与驱动兼容、调试入口、登录态、是否依赖有界面的浏览器 |

### 应用 API、CLI 与 IPC

应用愿意维护的接口通常值得先调查。例如 LibreOffice UNO 提供对象模型和语言绑定，可用于文档能力适配；这类 SDK 的安装、绑定版本和宿主依然需要逐项验证。[LibreOffice SDK](https://api.libreoffice.org/)

Windows COM Automation 可以向自动化客户端暴露应用对象；Linux D-Bus 提供方法调用、消息与总线机制。它们都要求目标提供对应接口，不能把任意进程的所有内部方法自动变成公共 API。[Microsoft OLE Automation](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-oaut/2e27b533-5de4-46e9-9b3c-a6b5bcb161de) · [D-Bus 规范](https://dbus.freedesktop.org/doc/dbus-specification.html)

HTTP API 与本地 GUI 的数据范围可能不同。适配器应明确账号、工作区、服务端版本、缓存及同步状态；用服务端查询替代本地查询前，先证明两者符合相同的业务契约。直接读取导出文件也只能报告该快照的结果，不能据此宣称当前应用或服务端状态已改变。

### macOS 脚本与 iOS 动作

Scripting Bridge 适用于提供脚本接口的 macOS 应用，其概念指南属于 Apple 归档文档。Shortcuts 在 macOS 提供 `shortcuts` CLI，可接收输入并返回输出；含有提问或提示的快捷指令仍可能等待用户。[Scripting Bridge 指南](https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/ScriptingBridgeConcepts/Introduction/Introduction.html) · [Shortcuts 命令行](https://support.apple.com/guide/shortcuts-mac/run-shortcuts-from-the-command-line-apd455c82f02/mac)

App Intents 用于应用向系统表达动作。适配时只能依赖目标实际公开的动作及可用调用入口，不能从框架的存在推断任意 iOS 应用都可以无界面控制，也不能把 macOS 的 `shortcuts` 命令直接假定为 iOS 本机 CLI。[Apple AppIntent](https://developer.apple.com/documentation/appintents/appintent)

### 浏览器与桌面语义接口

WebDriver 提供浏览器远程控制协议；Playwright 支持多种浏览器，但 CDP 连接仅适用于 Chromium，且能力保真度低于 Playwright 自身协议。Playwright 的 Electron 支持仍标为实验性，不能假设任意打包后的 Electron 应用都开放了可连接入口。[W3C WebDriver](https://www.w3.org/TR/webdriver2/) · [Playwright 浏览器](https://playwright.dev/docs/browsers) · [CDP 连接](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp) · [Electron 支持](https://playwright.dev/docs/api/class-electron)

UIA、AX、AT-SPI 可以作为语义控件与动作的接入层。应用暴露的树和操作仍需实测，尤其是自绘控件。macOS 需要检查辅助功能客户端信任状态；Linux 的桌面 portal 有独立的会话和授权流程。[Windows UIA](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32) · [Apple 辅助功能信任状态](https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted) · [AT-SPI](https://gnome.pages.gitlab.gnome.org/at-spi2-core/libatspi/) · [Remote Desktop portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

业务调用方无需理解 GUI，不等于后端无需 GUI 会话。辅助功能和界面测试后端要记录窗口、焦点、锁屏和交互权限条件；当前版本也不能把准备页面造成的状态改变隐藏在 `read_only` 声明内。

### 移动端公开组件与测试驱动

Android Intent 提供组件消息机制，ContentProvider 提供受权限约束的数据入口，AIDL 描述跨进程服务契约。发送 Intent 或成功建立连接只能证明请求被接受，业务完成仍需返回数据、可查询状态或事件证据。[Intents](https://developer.android.com/guide/components/intents-filters) · [ContentProvider](https://developer.android.com/guide/topics/providers/content-provider-basics) · [AIDL](https://developer.android.com/develop/background-work/services/aidl)

UI Automator 可用于 Android UI 测试；Appium 通过不同驱动接入不同目标，统一的是调用框架。驱动安装、设备连接和目标支持需要分别验证。[UI Automator](https://developer.android.com/training/testing/other-components/ui-automator) · [Appium 驱动目录](https://appium.io/docs/en/latest/ecosystem/drivers/)

iOS XCUITest/WDA 的完整构建与模拟器路线依赖 macOS/Xcode。当前官方文档也列出 Windows/Linux 的有限真实设备支持：需要满足指定系统版本、RemoteXPC 条件，以及预装或外部维护的 WDA，不能在这些主机上直接构建 WDA 或运行 iOS 模拟器。适配器必须锁定并验证具体组合。[XCUITest 系统要求](https://appium.github.io/appium-xcuitest-driver/12.8/getting-started/system-requirements/) · [非 macOS 主机条件](https://appium.github.io/appium-xcuitest-driver/latest/guides/non-macos-hosts/)

### 插桩与视觉方案

Frida 提供注入、嵌入和预加载等模式。其他可调查方向包括 JVM 的 JVMTI，以及用于受控调试和验证的 LLDB 接口；它们的进程、运行时及部署条件不同。发现一个内部函数后，仍需建立参数、线程、版本与完成条件契约，才能进入业务执行路径。[Frida 模式](https://frida.re/docs/modes/) · [JVMTI](https://docs.oracle.com/en/java/javase/25/docs/specs/jvmti.html) · [LLDB](https://lldb.llvm.org/use/tutorial.html)

视觉方案可以帮助定位无语义树的元素，例如 OpenCV 模板匹配；OCR 或视觉模型还可以提供文本及候选区域。项目建议把识别结果视为候选证据，结合状态验证、置信度阈值和有限重试。截图相似或点击成功都不能单独证明业务完成。[OpenCV 模板匹配](https://docs.opencv.org/4.x/d4/dc6/tutorial_py_template_matching.html)

## 选型与组合规则

1. 定义同一业务的输入、输出、数据来源和完成标准，再调查应用 API/SDK、CLI、公开 IPC 和脚本入口。
2. 对每个候选记录是否支持目标版本、是否需要交互会话、准备动作的副作用、结果可验证性和维护成本。文件快照只能用于允许离线或历史数据的契约。
3. 缺少合适业务接口时，评估浏览器 DOM 或辅助功能语义。根据应用所有权和运行环境，再比较测试驱动、插桩与视觉方案；顺序不是固定的性能排名。
4. 执行前选定并记录后端。发生权限拒绝、结果不确定或可能已提交的写操作时，不得自动切换另一条路径重新执行。切换后端也不能扩大原来的授权范围。
5. 同一只读查询的备用实现需先验证账号、数据新鲜度、字段含义和结果范围等价。核心目前没有自动降级或重试机制。

建议将未来适配器内部拆为“环境检查 → 调用 → 结果验证”三个阶段，并将业务适配器、访问后端与本地/远程传输分别维护。当前公开接口仍是 `manifest` 与 `invoke(command, arguments)`，这些阶段不是已实现的新方法。

## 最小可复现实验与验收

| 候选路线 | 首个实验 | 进入支持范围前的证据 |
| --- | --- | --- |
| API/CLI | 在自有应用中执行确定性的只读运算或查询 | 与应用直接执行结果一致；错误、超时、版本不匹配和格式变化可识别 |
| 系统脚本/IPC | 自有组件公开一个只读属性或查询 | 不同会话、拒绝访问、接口缺失和进程退出都得到准确结果 |
| 浏览器 | 自有静态页面或测试站点上的只读内容查询 | 浏览器版本、异步加载和定位失败证据；记录是否需要预先打开页面 |
| UIA/AX/AT-SPI | 在已准备好的自有窗口读取同一语义字段 | 控件覆盖、焦点/窗口状态、权限变化和 UI 更新后的结果 |
| Android/iOS 测试驱动 | 在专用测试应用中查询已知状态 | 真实主机/设备/工具链组合、会话建立与销毁、断连和目标升级 |
| 插桩/视觉 | 自有构建暴露已知方法或固定语义的测试画布 | 方法/图像识别正确性、版本或缩放变化、独立结果核对 |

环境安装、权限授予和 GUI/设备准备要单独记录；这类准备步骤也可能有副作用。测试记录应包括具体主机与目标版本、冷启动/已有会话、时延分布、成功/失败/未知结果数及人工介入次数，不能只展示一次成功调用。

实施顺序见[路线图](ROADMAP.md)，编写适配器时使用[开发规范](ADAPTER-DEVELOPMENT.md)和[贡献证据模板](../CONTRIBUTING.md#adapter-evidence-template)。
