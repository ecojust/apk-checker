# i歌霸安全登录弹窗与原生模拟器窗口

用户在 0.2.1 ARM Mac 上确认麦动窗口已持续打开，但「i歌霸账号」登录弹窗黑屏。本次处理不输入账号密码、不提交登录，也不修改原版 APK。

## 已确认原因

原版麦动 2.1.8 的 `IgebaAccountDialog.kt:64-65` 在原生 AlertDialog 显示时调用 `Window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)`。同一官方 APK 的 SHA-256 仍为 `86ef92ec8b1ac277eb68f28f3ff4fb421f7bc2a1e6093229a706d3aaa0310a3b`；其 `classes.dex` 中混淆方法 `Lh1/q;.onShow` 在 `0x15a3a4` 加载 `8192 / 0x2000`，随后在 `0x15a3a8` 调用 `Window.addFlags(I)`，与源码一致。

[Android 对 FLAG_SECURE 的定义](https://developer.android.com/reference/android/view/WindowManager.LayoutParams#FLAG_SECURE)会阻止该窗口出现在截图或非安全显示中。0.2.1 使用无窗口模拟器和 scrcpy 投屏，因此登录表单被遮黑。它是本地 `AlertDialog + EditText`，不是 WebView；打开表单时还未提交网络登录请求，不能把这个现象归因于密码、服务器或网页加载。

## 0.2.2 显示方式

生产管理环境使用模拟器自己的原生设备窗口。安装仍可在后台完成；第一次打开时保存并停止本程序启动的后台实例，再使用同一 AVD 和数据启动原生窗口。已运行的原生窗口复用，关闭后再打开会重新启动模拟器。已有 APK、安装记录和数据保留。

`-no-window` 会选择独立的 headless 程序，无法恢复 Qt 窗口，所以切换时必须重启自身模拟器。实现会等待进程真正退出，并检查 `adb emu avd windowtype` 返回 `windowtype=qtwindow`。不擅自关闭外部模拟器，不清除 `FLAG_SECURE`，不重新签名或改包，也不关闭 GPU。

首次切换需要等待模拟器保存和重新启动，界面会显示进度。已有原生窗口被最小化时，可能需要从系统 Dock／任务栏恢复；当前没有添加跨平台窗口置顶的系统权限要求。旧投屏代码保留作兼容诊断，生产自动准备的环境始终使用原生窗口。

## 验证方式与当前边界

- 自动测试实际执行「后台安装 → 保存／关停 → 同 AVD 原生打开」，核验设备、安装记录、进程退出和原生窗口类型。
- 可选登录检查只通过稳定控件打开「设置 → i歌霸账号」，验证原生用户名／密码输入框和原始安全窗口标记，不输入或提交任何凭据。
- 同时采集 Android 内部截图和独立 CI 宿主显示：前者输入区应保持安全遮黑，原生宿主窗口的对应区域应可见。截图只含全新设备的空表单；预览用于人工核验控件内容。
- 按 Back 关闭表单并确认正常页面恢复，再卸载测试 APK 和清理全部私有进程。

目前源码／原版 DEX 已确认根因；原生显示回归、实际安全弹窗截图和 0.2.2 安装包验收结果将在本记录追加。此前 0.2.1 完整链路见[运行环境报告](managed-runtime.md)，不能替代本次安全弹窗验证。

## 已执行的 0.2.2 验证及保留失败

- `223d85a` 的[三平台安装包构建 42061147332](https://github.com/ecojust/apk-checker/actions/runs/42061147332) 全部通过，Mac 两种架构的 DMG、签名、应用启动和工具检查通过；全量 164 项本地测试通过。
- [首次原生 APK run 42061147067](https://github.com/ecojust/apk-checker/actions/runs/42061147067)：手机原生 QEMU 因 Linux CI 缺 `libpulse.so.0` 退出 127；TV 在原有 180 秒安装时限失败。均未进入安全表单验证。
- 补齐 CI `libpulse0` 后，`2ee9c03` 的[run 42065213408](https://github.com/ecojust/apk-checker/actions/runs/42065213408) 手机和电视都通过安装、原生窗口启动、宿主截图、前台检查、卸载及全部私有进程退出；TV 本轮安装约 60 秒，没有扩大时限。
- 本轮整体仍失败：手机已确认原生登录 EditText 和 `FLAG_SECURE`，随后 guest `screencap` 未返回 PNG，原检查尚未发布宿主表单预览；TV 首页 UI 树中未找到指定设置控件。正在保留具体截图诊断、先采集独立宿主表单并增加有界 UI 诊断，不能把这轮写成安全表单全通过。
