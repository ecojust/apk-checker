# 模拟器快照恢复失败与冷启动

## 现场错误及诊断

2026-11-08，用户报告 Apple Silicon Mac 的电视模式在安装 APK 时等待超过三分钟，随后补充模拟器始终无法启动。用户未提供客户端版本；本次修复从仓库 master `6c00da1` 开始，对照已发布的 0.2.4。

关键日志：

```text
虚拟设备启动失败：退出代码：0
[h264 @ 0xb58e49900] no frame!
qemu-system-aarch64: error while loading state for instance 0x0 of device 'goldfish_pipe'
```

后续日志还有 macOS IMK 和键盘提示。`error while loading state` 来自 QEMU 加载设备保存状态失败的路径（[官方源码](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/migration/savevm.c)），退出代码 0 不能替代 Android 启动就绪检查。现有日志能确定恢复状态失败，不能单独证明快照为什么失效，也没有依据将这些键盘提示视为主因或改动 GPU／系统镜像。

当前 Apple Silicon TV 资源为 Emulator 37.2.13、Android TV 16 / API 36 / arm64-v8a，私有 AVD 名称 `APKChecker_TV_36_arm64_v8a`。安装先启动后台模拟器，打开应用时关闭后台进程并用原生窗口重新启动同一个 AVD；旧参数允许恢复上一次保存的状态。

Android 官方说明：

- [快照说明](https://developer.android.com/studio/run/emulator-snapshots)：快照依赖保存时的镜像、AVD 配置和模拟器功能，恢复启动失败时建议 Cold Boot。
- [命令行参数](https://developer.android.com/studio/run/emulator-commandline)：`-no-snapshot-load` 执行冷启动，并仍可在退出时保存状态；`-wipe-data` 会清空用户数据，本修复不使用它。

## 0.2.4 的临时恢复方法

1. 完全退出 APK Checker，并关闭由它启动的模拟器，等待进程退出。
2. 在 Finder 使用「前往 → 前往文件夹」，打开：

   ```text
   ~/Library/Application Support/apk-checker/managed-runtime/avds/APKChecker_TV_36_arm64_v8a.avd/
   ```

3. 先复制 `config.ini` 留作备份，再用纯文本编辑器将已有的一行 `fastboot.forceColdBoot=no` 改为 `fastboot.forceColdBoot=yes`，保存。
4. 重新打开 APK Checker，重试电视模式。此次会冷启动，可能比正常快照启动慢。

这个目录来自既有现场记录和当前私有 AVD 命名；如果目录或配置不存在，应先核对实际应用数据目录，不要新建空配置。其他架构／模式的 AVD 名称不同，不要套用上述 TV ARM64 路径。

此方法改变启动方式，不删除快照目录、`userdata-qemu.img`、APK 或软件库。重复准备运行环境保留已有配置，因此此设置会继续生效；安装包含自动恢复修复的版本后，可在完全退出程序时将该行改回 `no`，恢复正常 Quick Boot。尚未收到用户本机操作结果。

## 自动恢复实现

修复源码版本为 0.2.5，基于 0.2.4；实际发布状态见下文。

- 捕获模拟器 stdout 和 stderr，并限制保存的输出量；单独保留关键状态恢复错误，避免后续系统提示覆盖原因。
- 仅在本程序启动的模拟器出现明确的状态恢复错误时，确认旧进程退出后，使用同一 AVD 和私有环境添加 `-no-snapshot-load` 冷启动重试一次。
- 后台安装转原生窗口时直接冷启动，避免恢复不同显示后端的内存状态；磁盘上的 APK 和用户数据保留。
- 已退出但返回 0、仍存活但报恢复错误都属于启动失败；安装仍须等目标 AVD 的 `sys.boot_completed=1`。
- 退出／取消后不再创建新进程；旧进程无法确认退出时不创建第二个实例，保留进程归属供后续清理。外部模拟器不触发此恢复。
- 普通 H.264／IMK 提示不会触发重试；无关启动失败照常返回，冷启动再次失败时保留两次诊断。每次启动期限仍为三分钟，超时附带最后连接阶段和日志。

## 验证与交付状态

- 独立代码与文档审查通过，无阻断问题。2026-11-08 本地 `npm run check`、`npm test`、`npm run build`、`git diff --check` 均通过；全部 8 个测试文件、240 项测试通过，其中 AndroidRuntime 108 项，本次新增 16 项。
- 故障回归覆盖：用户原始错误和退出代码 0；stdout／stderr 分块及后续噪声；退出事件后异步尾日志；仍存活的失败进程；二次失败不再重试；重试准备失败保留首因；无法停止时保留归属；退出／取消；外部设备隔离；超时阶段、ADB 错误及两路输出。后台转原生窗口回归确认同一 AVD、先退出再冷启动及无 `-wipe-data`。
- 当前开发环境为 Linux；单元测试使用模拟子进程与 adb 输出，不能作为 Apple Silicon Mac 上实际启动 Android TV 的证据。
- 修复源码 [3b14668](https://github.com/ecojust/apk-checker/commit/3b14668d9d93581e64f706cb627b404efcd31ab3) 已推送至 `fix/emulator-snapshot-recovery`，见 [PR #2](https://github.com/ecojust/apk-checker/pull/2)。[原生安装包构建 42495266207](https://github.com/ecojust/apk-checker/actions/runs/42495266207)已 completed／success：Apple Silicon、Intel Mac 和 Windows 三平台全部通过并上传安装包；同一 SHA 的重复 PR 构建已取消以避免重复打包。
- 既有 [v0.2.4](https://github.com/ecojust/apk-checker/releases/tag/v0.2.4) 及其附件没有改变，不包含此次修复；尚未合并 master 或发布 0.2.5 Release。
- Mac 构建工作流会检查安装包、ad-hoc 签名、客户端启动和 IPC；它不启动 API 36 Android TV，不能代替用户设备的冷启动验收。

## 修复测试包

[下载 Apple Silicon Mac 0.2.5 测试包](https://github.com/ecojust/apk-checker/actions/runs/42495266207/artifacts/13623123152)。需登录 GitHub；解压后打开 `APK Checker-0.2.5-mac-arm64.dmg`，将应用拖到「应用程序」替换旧版，再重试电视模式。原应用数据目录继续复用。

该 artifact 的来源 SHA 已通过 GitHub API 核对为 `3b14668d9d93581e64f706cb627b404efcd31ab3`。对应 [ARM 原生 job](https://github.com/ecojust/apk-checker/actions/runs/42495266207/job/128776141401) 的 240 项测试、构建、包内工具原生执行、DMG／签名／客户端启动验证及上传均 success。安装包内附 `SHA256SUMS.txt`，可按 README 核验；它与 GitHub 对 artifact ZIP 的摘要是不同对象。

已读取完成后的 ARM job 日志，记录 DMG SHA-256：

```text
b6bbc64cdf9b6ba4089f7054b779c30759e2451c57e73cce30719e74c44d7507  APK Checker-0.2.5-mac-arm64.dmg
```

同一源码的[Intel Mac 测试包](https://github.com/ecojust/apk-checker/actions/runs/42495266207/artifacts/13622854359)和[Windows 测试包](https://github.com/ecojust/apk-checker/actions/runs/42495266207/artifacts/13623212586)也已生成。

CI artifact 保留 14 天，当前过期时间为 2026-11-22 UTC；这是修复测试包，尚未发布为 GitHub Release。现阶段未在本地下载该 DMG，摘要、签名和启动结果来自原生 CI 日志，元数据及来源 SHA 另经 GitHub API 核对。Mac 使用 ad-hoc 签名，未做 Apple 公证；遇到系统拦截时按 README 的 macOS 安装说明操作。用户 Mac 的 Android TV 实际恢复结果仍待反馈。

持续记录见 [history](../../history/2026-11-08-001.md)。
