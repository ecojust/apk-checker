# APK Checker

用于管理和运行 Android APK 的桌面应用，面向 **macOS Apple Silicon、macOS Intel 和 Windows x64**。导入后在软件库点击安装，再选择手机或电视；安装成功的应用统一显示在桌面，卡片标注设备类型，点击即可打开对应窗口。

**0.2.4 无需安装 Android Studio、Java、aapt / aapt2，也无需配置 SDK、scrcpy 路径或手动创建虚拟设备。** APK 解析使用随应用内置的 JavaScript 模块，导入可完全离线进行。构建时将内部通信组件 Platform-Tools 和显示组件 scrcpy 随包提供；Android 模拟器引擎及所选系统镜像在首次使用时自动下载、校验并保存，完成后可离线启动。

界面使用 Electron + React，Android 运行由 Emulator 提供。从 0.2.2 起默认使用模拟器原生窗口，用于显示麦动这类禁止投屏的安全登录弹窗；修复证据见[安全登录说明](docs/testing/secure-login.md)。程序只管理自己的手机／电视模拟器，没有连接、调试或部署到真实设备的界面。内部仍使用 adb 安装应用和控制模拟器，用户无需单独配置它。

0.2.4 安装包：[Apple Silicon Mac](https://github.com/ecojust/apk-checker/actions/runs/42133367618/artifacts/13464527795) · [Windows x64](https://github.com/ecojust/apk-checker/actions/runs/42133367618/artifacts/13464632255)。Intel 首轮构建、签名和客户端启动检查通过，但安装包上传超时；定向重试又遇到运行组件下载失败，当前没有可下载的 Intel 0.2.4 包。[构建记录](https://github.com/ecojust/apk-checker/actions/runs/42133367618)及[新界面与验收报告](docs/testing/install-choice.md)保留具体结果。CI 产物保留 14 天，包含安装包和 SHA-256 校验文件；可按文末命令重新构建。

## 首次使用

1. 打开客户端，点击「导入 APK」，可同时选择多个 `.apk`。无需先准备模拟器。
2. 在软件库点击「安装」，在弹窗中选择手机或电视，再确认安装；也可先到「模拟器设置」准备对应设备。
3. 首次准备时阅读许可条款并勾选同意。客户端显示预计下载量，自动准备所需文件和虚拟设备；下载可取消并重试，部分下载支持续传。
4. 等待真实安装成功，切换到「桌面」，根据卡片上的手机／电视标签点击打开对应窗口。失败时会保留错误信息，不会将应用标记为已安装。
5. 电视模式可使用方向键、Enter 和返回键；完整快捷键见 [scrcpy 控制文档](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md)。

资源优先来自 Google Android 官方下载和 scrcpy 官方发行版；Android 文件在官方源不可用时可使用腾讯镜像，始终按内置目录的固定大小和摘要校验。首次准备需要联网和足够磁盘空间，界面会提示下载量并检查可用空间。引擎和镜像合计约 1.4–1.9 GB 压缩下载，解压、缓存和 Android 用户数据还会占用更多空间，建议每种模式至少预留 25 GB；只准备需要的模式即可。准备第二种模式时会复用已有引擎。

当前资源目录自动选择：

| 宿主系统 | 手机模式 | 电视模式 |
| --- | --- | --- |
| macOS Apple Silicon | Android 11 / API 30 / ARM64 | Android TV 16 / API 36 / ARM64 |
| macOS Intel | Android 11 / API 30 / x86_64 | Android TV 16 / API 36 / x86_64 |
| Windows x64 | Android 11 / API 30 / x86_64 | Android TV 16 / API 36 / x86_64 |

**宿主机的硬件虚拟化能力不能内置。** Mac 使用系统提供的虚拟化支持；Windows 需要 CPU 和 BIOS/UEFI 启用虚拟化，并启用可用的 Windows Hypervisor Platform。遇到加速器错误时参见 [Android Emulator 加速文档](https://developer.android.com/studio/run/emulator-acceleration)。嵌套虚拟机或不支持虚拟化的主机可能无法运行。

系统准备完成后的「可离线启动」指模拟器环境，APK 自身的联网、账号或在线服务仍由应用决定。APK 的原生库架构、最低 Android 版本及电视适配也必须兼容所选系统，不能保证所有 APK 在三种宿主机上均可运行。

## 窗口和模式

桌面与软件库统一展示，不再通过顶部模式 Tab 分类。软件库每个 APK 一张卡片；同一 APK 可分别安装到手机和电视，桌面会显示两张带对应设备标签的卡片。卡片的打开、卸载始终操作该设备；软件库的“已安装”筛选表示任一设备已安装。

手机与电视使用不同的私有虚拟设备（AVD），安装状态分别记录，可同时运行。电视模式使用真实电视系统，并优先选择 APK 的 `LEANBACK_LAUNCHER` 入口，没有该入口时尝试普通入口。

同一模式内的应用共用一台 Android 设备。打开另一款应用会切换前台并替换该设备的显示窗口，不是一款应用一台独立 Android 实例。关闭显示窗口不会卸载应用；完全退出 APK Checker 会关闭由本程序启动的显示窗口、模拟器及私有通信服务。

程序使用独立的 AVD 目录和本地 adb 服务端口，不接管 Android Studio 的设备或默认 adb 服务。0.1.x 的外部 SDK 路径和 AVD 绑定属于旧版配置；升级后保留软件库，但应用需要重新安装到新建的私有模拟器中，旧设备的数据不会自动迁移或删除。

## macOS 安装与「已损坏」提示

从本仓库的构建产物下载对应芯片版本：Apple Silicon 使用 `macOS-arm64`，Intel 使用 `macOS-x64`。解压后先在产物目录核验下载完整性：

```sh
shasum -a 256 -c SHA256SUMS.txt
```

确认通过后打开 DMG，将 `APK Checker.app` 拖入「应用程序」，替换旧版。0.1.1 起对完整应用包和 Chromium 辅助程序执行 ad-hoc 签名；CI 会挂载实际 DMG、核验签名，并在对应架构的 macOS 主机上启动包内应用、验证界面和 IPC。0.1.0 的构建关闭了自动签名，却未明确重新签名修改后的 Electron 应用包，应换用新包。

ad-hoc 签名保证包内代码签名完整性，**不等于 Developer ID 签名或 Apple 公证**。首次下载仍可能被 Gatekeeper 拦截。提示无法验证开发者时，在尝试打开后前往「系统设置 → 隐私与安全性 → 仍要打开」。

如果来自本仓库、校验和通过的新包仍提示「已损坏」，先核验安装后的应用：

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/APK Checker.app"
```

签名核验通过、仍被下载隔离属性拦截时，可只对这份可信应用移除隔离属性后重新打开：

```sh
xattr -dr com.apple.quarantine "/Applications/APK Checker.app"
```

上述操作不需要 `sudo`，不关闭全局 Gatekeeper。若校验和或签名核验失败，应重新下载并替换该应用，而不是扩大解除隔离的范围。构建产物中的 `mac-verification.json` 记录签名、DMG 完整性、实际启动及 Gatekeeper 评估结果。已完成的原生验收及手机／电视完整流程见[0.2.1 运行环境报告](docs/testing/managed-runtime.md)；旧版记录见[打包修复报告](docs/testing/macos-0.1.1.md)。

后台安装后的第一次打开会保存并重启同一个模拟器，以显示原生窗口，APK 和数据会保留。后续会复用该模式的原生窗口；如果已最小化，可从 Dock／任务栏恢复。关闭原生窗口会退出对应模拟器，再次打开应用会自动启动。手机模式运行横屏软件时，可用原生窗口侧边栏的旋转按钮调整方向。

### 用电脑输入文字

如果电脑输入法的候选文字没有进入 Android 输入框，可在 0.2.3 中：

1. 先在模拟器里选中要填写的输入框，确认光标出现。麦动等电视软件可能需要使用 Tab／方向键获得键盘焦点，单击不一定生效。
2. 回到 APK Checker 桌面，点击“输入文字”。两种模拟器同时运行时，先选择需要填写的设备；仅一种运行时会直接选择它。
3. 用电脑键盘和输入法写好内容，点击“发送文字”。确认文字已进入模拟器后，再操作软件的搜索或登录按钮。

选字时 Enter 只确认候选；再次 Enter 发送，Shift+Enter 换行。文字只暂存在当前弹窗内存，关闭后清空；单次最多 16 KB。发送不会附加 Android Enter 或自动提交表单。原生窗口直接接收宿主中文输入法仍受 Emulator 限制，该入口提供独立的完整文字通道；验证范围见[键盘与文字输入记录](docs/testing/keyboard-input.md)。


## 软件库与本地数据

- APK 副本和 `library.json` 保存在 Electron 的本地 `userData` 目录中，源 APK 不会被修改；托管运行文件与私有 AVD 保存在同一应用数据目录下。
- 相同文件自动去重；支持搜索、移除。相同包名的新 APK 会替换库中旧版本，并清除桌面安装标记。设备中的旧版本保留，重新安装时尝试更新；签名冲突或降级可能被 Android 拒绝。
- 「卸载」移除卡片／菜单指定设备中的应用及其数据；「从软件库移除」删除缓存和库记录，不删除源文件。有安装记录时，需要先卸载再移除。
- 只支持单个完整 APK，不直接导入 AAB、APKS、XAPK 或一组拆分 APK。
- 索引损坏时保留原文件并生成备份，不会静默清空软件库。重复准备运行环境不会重建已有虚拟设备或清除其用户数据。

## 本地开发

需要 Node.js 22.12 或更新的兼容版本和 npm。无需安装 Android 开发工具。

```sh
git clone https://github.com/ecojust/apk-checker.git
cd apk-checker
npm ci
npm run dev
```

`npm run dev` 启动 Vite 和 Electron。仅开发界面、导入 APK 或运行单元测试，无需下载模拟器资源；要调试安装和运行流程，先执行 `npm run runtime:prepare` 将当前平台的内部通信／显示组件准备到 `resources/runtime-bundled`，再在客户端准备所选系统。

仅预览浏览器界面可使用 `npm run dev:web`；浏览器不会执行 Android 操作，也不会伪造安装结果。

```sh
npm run check
npm test
npm run build
```

自动化覆盖内置 APK 解析、软件库持久化、运行环境准备与模式隔离。验证范围及待验项目见 [0.2.1 运行环境记录](docs/testing/managed-runtime.md)。原版麦动 KTV 2.1.8 的既有 Linux 模拟器结果见[APK 测试报告](docs/testing/maidong-2.1.8.md)；旧版测试不能代替新托管环境或 macOS / Windows 上的真实 APK、媒体播放和性能验收。

当前保留 Electron 实现。Tauri 2 + Rust 是减少管理界面开销的候选方案，尚未迁移，也没有据此声称已改善内存、帧率或延迟；Android 虚拟化、ARM 转译和 APK 本身的负载需要分别测量。

## 构建安装包

在对应目标架构的 macOS 主机上执行：

```sh
npm run dist -- --mac dmg --arm64 --publish never
# Intel Mac 改用：npm run dist -- --mac dmg --x64 --publish never
```

Windows x64：

```powershell
npm run dist -- --win nsis --x64 --publish never
```

`dist` 自动执行生产构建和 `runtime:prepare`，再打包。准备脚本从固定来源下载并校验 Platform-Tools、scrcpy 原始归档和许可证，打入应用资源；下载或校验失败会中止打包。它不将 Emulator 和系统镜像打入安装包。若分开调用 electron-builder，也必须先执行 `npm run build`、`npm run runtime:prepare`。

准备脚本默认匹配当前宿主架构。查看其他平台清单可使用 `npm run runtime:prepare -- --platform darwin --arch arm64 --dry-run`；手动跨架构构建时须明确准备相同目标的资源，原生启动验收仍需目标主机。

产物位于 `release/`。[GitHub Actions](.github/workflows/build.yml) 为两种 Mac 和 Windows x64 生成安装包及 SHA-256 校验文件作为 workflow artifacts，不自动发布 Release。macOS 继续使用 ad-hoc 签名和 DMG／签名／原生启动检查；未配置 Developer ID、Apple 公证或 Windows 代码签名。新增运行环境需要在新版产物上重新验收。

## 项目结构

```text
electron/main.ts             窗口、受限 IPC 与操作调度
electron/apk-metadata.ts     内置二进制 Manifest 和资源解析
electron/library.ts          APK 缓存、安装记录与原子持久化
electron/managed-runtime.ts  下载校验、资源准备和私有 AVD
electron/android.ts          模拟器、内部通信与显示进程
resources/                   固定资源目录、许可证和构建时归档
src/                         React 桌面、软件库与运行环境界面
tests/                       自动化回归
```

## 许可证

[MIT](LICENSE)。Android 组件、系统镜像、scrcpy 和导入的 APK 分别遵循各自许可。首次准备会展示适用条款；许可文本变更后需要重新确认。
