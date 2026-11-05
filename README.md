# APK Checker

用于管理和运行 Android APK 的桌面应用，面向 **macOS Apple Silicon、macOS Intel 和 Windows x64**。导入安装包后，在软件库中选择手机或电视模式安装；安装成功的应用显示在对应模式的桌面中，点击即可通过独立窗口操作。

应用使用 Electron + React 构建界面，使用 **Android SDK Emulator** 运行 Android，并通过 **scrcpy** 显示和控制虚拟设备。Android SDK、系统镜像、scrcpy 和 APK 均不随安装包分发，需要先在本机准备。

## 功能

- 批量导入 `.apk`，读取名称、包名、版本和最低 Android 版本，保存安装包副本。
- 相同文件自动去重；软件库支持搜索和移除。
- 手机和电视各自绑定一个 AVD，分别记录安装状态。
- 安装时自动启动所选虚拟设备，等待 Android 就绪后执行实际安装。
- 桌面只显示已安装到当前模式所选 AVD 的应用；支持打开和卸载。
- 每次打开应用都会显示独立的 scrcpy 窗口，支持鼠标、键盘输入。
- 检测 SDK、adb、Emulator、Build-Tools、scrcpy 和可用虚拟设备，显示缺失项及操作错误。

同一模式中的应用共用一台 Android 虚拟设备。打开另一款应用会切换设备的前台应用并替换该设备的显示窗口；它们不是每款应用各自独立的 Android 实例。手机和电视使用不同 AVD，可以同时运行。关闭显示窗口不会卸载应用；完全退出 APK Checker 会关闭由它启动的显示窗口和模拟器，不会关闭预先由其他程序启动的模拟器。

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

上述操作不需要 `sudo`，不关闭全局 Gatekeeper。若校验和或签名核验失败，应重新下载并替换该应用，而不是扩大解除隔离的范围。构建产物中的 `mac-verification.json` 记录签名、DMG 完整性、实际启动及 Gatekeeper 评估结果。

## 首次配置

### 1. 安装 Android SDK

安装 [Android Studio](https://developer.android.com/studio)，在 **SDK Manager → SDK Tools** 中安装：

- Android SDK Platform-Tools（`adb`）
- Android Emulator
- Android SDK Build-Tools（`aapt` / `aapt2`，导入 APK 时用于解析元数据）

记下 Android SDK Location。常见路径如下：

| 系统 | 默认 SDK 路径 | 推荐系统镜像架构 |
| --- | --- | --- |
| macOS Apple Silicon | `~/Library/Android/sdk` | `arm64-v8a` |
| macOS Intel | `~/Library/Android/sdk` | `x86_64` |
| Windows x64 | `%LOCALAPPDATA%\Android\Sdk` | `x86_64` |

程序会查找 `ANDROID_SDK_ROOT`、`ANDROID_HOME` 和常见 SDK 安装路径，也可以在「运行环境」中手动选择 SDK 根目录。手动选择目录时，请选择包含 `platform-tools`、`emulator` 和 `build-tools` 的目录。

### 2. 创建手机和电视虚拟设备

在 Android Studio 的 **Device Manager → Create Device** 中分别创建：

1. 一台 Phone 设备，例如 Pixel，使用与宿主机架构匹配的 Android 系统镜像。
2. 一台 TV 设备，使用 Android TV 或 Google TV 系统镜像。

建议先在 Android Studio 中启动一次，完成系统初始化后关闭。Windows 需要启用硬件虚拟化，并按 [Android Emulator 加速文档](https://developer.android.com/studio/run/emulator-acceleration) 配置可用的虚拟化后端。

**Apple Silicon 上的电视模式取决于 SDK 是否提供可运行的 ARM64 电视镜像。** 部分 Android TV 版本只提供 x86 镜像；不能把此类镜像当作 Apple Silicon 原生可用镜像。请在 SDK Manager 中确认镜像架构。没有兼容电视镜像时，仍可使用手机模式；电视模式需要换用兼容镜像或 Intel / Windows x64 主机。选择 TV 模式不会把普通手机镜像变为电视系统。

APK 的原生库架构和最低 Android 版本也必须与所选系统镜像兼容；应用会显示 Android 返回的安装错误。

### 3. 安装 scrcpy

macOS 可以通过 [Homebrew](https://brew.sh/) 安装：

```sh
brew install scrcpy
```

Windows 请从 [scrcpy 官方发布页](https://github.com/Genymobile/scrcpy/releases) 下载并完整解压 Windows 版本，保留其依赖文件。随后在应用中选择解压目录下的 `scrcpy.exe`。

程序会从 `PATH` 和常见 Homebrew 路径查找 scrcpy，也支持手动选择其**可执行文件**。macOS 从 Finder 启动时可能不会继承终端的 `PATH`，此时可选择 `/opt/homebrew/bin/scrcpy`（Apple Silicon）或 `/usr/local/bin/scrcpy`（Intel）。

### 4. 在应用中绑定设备

打开 APK Checker 的「运行环境」，检查 SDK 和 scrcpy，刷新检测结果，为手机和电视分别选择对应 AVD 并保存。两种模式不能绑定同一个 AVD。可以先只配置其中一种模式。

## 使用流程

1. 点击「导入 APK」，可同时选择多个安装包。
2. 在「软件库」中找到应用，选择手机或电视模式并点击安装。
3. 等待真实安装完成；首次启动模拟器可能需要几分钟。
4. 切换到「桌面」，点击应用打开独立显示窗口。
5. 电视模式可使用方向键和 Enter 操作焦点；鼠标右键可返回。完整快捷键参见 [scrcpy 控制文档](https://github.com/Genymobile/scrcpy/blob/master/doc/control.md)。

电视模式优先使用应用的 `LEANBACK_LAUNCHER` 启动入口；没有该入口时尝试普通启动入口。应用是否支持电视界面、遥控器、横屏或特定服务，取决于 APK 本身。

安装记录绑定实际 AVD 名称。更换某种模式的 AVD 后，需要将软件安装到新设备；原设备中的应用不会自动迁移。若在 Android Studio 中清空或重建了同名 AVD，请重新安装应用以恢复设备内容。

## 软件库与数据

- APK 副本和 `library.json` 保存在 Electron 的本地 `userData` 目录中，源 APK 不会被修改。
- 同一包名的新 APK 会替换软件库中的旧版本并清除其桌面安装标记，避免将新版本误报为已安装。虚拟设备中的旧版本仍然保留；再次安装使用 `adb install -r` 更新，兼容升级通常保留数据。签名不一致或降级可能被 Android 拒绝。
- 「卸载」会从所选虚拟设备移除应用及其数据；「从软件库移除」删除缓存 APK 和软件库记录，不删除原始文件。仍有安装记录时，需要先卸载再移除。
- 目前支持单个完整 APK，不支持直接导入 AAB、APKS、XAPK 或一组拆分 APK。
- 若索引损坏，程序会保留原文件并生成备份，显示恢复路径，不会静默重置软件库。

## 本地开发

需要 Node.js 22.12 或更新的兼容版本、npm，以及上面的运行环境。仅运行界面和单元测试不需要 Android SDK。

```sh
git clone https://github.com/ecojust/apk-checker.git
cd apk-checker
npm ci
npm run dev
```

`npm run dev` 启动 Vite 和 Electron。Electron 中才能导入本地 APK、管理模拟器和打开应用窗口。浏览器中打开 Vite 地址可以查看界面，但不会执行 Android 操作，也不会伪造安装结果。

仅启动浏览器界面预览：

```sh
npm run dev:web
```

```sh
npm run check
npm test
npm run build
```

单元测试覆盖软件库持久化、APK 元数据和运行时关键逻辑；模拟器的真实安装、启动和输入仍需在配置好 SDK 的目标系统中验证。

已用原版麦动 KTV 2.1.8 进行实际 APK 导入和 Android 模拟器测试，结果及兼容性限制见[测试报告](docs/testing/maidong-2.1.8.md)。这不替代 macOS / Windows 实机性能和音视频播放测试。

## 构建安装包

在 macOS 上构建对应架构的 DMG：

```sh
npm run build
npx electron-builder --mac dmg --arm64 --publish never
npx electron-builder --mac dmg --x64 --publish never
```

在 Windows 上构建 x64 安装包：

```powershell
npm run build
npx electron-builder --win nsis --x64 --publish never
```

产物位于 `release/`。这三个产物分别面向 macOS Apple Silicon、macOS Intel 和 Windows x64，不是包含 Android 系统镜像的一体化安装包。

[GitHub Actions 构建工作流](.github/workflows/build.yml) 会运行测试并生成这三种安装包及 SHA-256 校验文件作为 workflow artifacts，**不会自动发布 Release**。macOS 使用 ad-hoc 签名并执行 DMG、签名和原生启动检查；仓库尚未配置 Developer ID 签名、Apple 公证或 Windows 代码签名。当前产物用于开发测试，正式分发前仍需相应签名配置和实机验收。

## 项目结构

```text
electron/main.ts       窗口、IPC、原生文件选择与操作调度
electron/preload.ts    受限的前端调用接口
electron/library.ts    APK 解析、缓存、安装记录与本地持久化
electron/android.ts    SDK 检测、AVD 启动、adb 操作与 scrcpy 窗口
src/                  React 桌面、软件库与运行环境界面
src/shared/types.ts   前后端共享类型
tests/                自动化测试
```

## 许可证

[MIT](LICENSE)。Android SDK、系统镜像、scrcpy 和所导入 APK 分别遵循各自的许可。
