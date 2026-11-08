# VsTV 安装与启动入口排查

## 用户现场

2026-11-08，用户在 Apple Silicon Mac 使用 APK Checker 0.2.5 测试包，反馈 Android 模拟器能显示系统桌面，但新 APK 没有图标。随后提供准确错误：

```text
此 APK 没有可启动的应用入口，可能是插件、服务或不兼容当前设备。
```

应用名称为 `vstv`；具体 APK 版本、文件和来源尚未确认。用户此前使用电视模式，本轮没有重新明确模式。该错误来自入口解析阶段，不能将本次现场直接归为应用崩溃、未安装或前台被覆盖。

## 已核对的官方安装包

下载来源：[vesaaa/vstv v2.8.0](https://github.com/vesaaa/vstv/releases/tag/v2.8.0)，原始文件 [vstv-2.8.0-arm.apk](https://github.com/vesaaa/vstv/releases/download/v2.8.0/vstv-2.8.0-arm.apk)。本地实际下载并重算 SHA-256，与 GitHub Release digest 相同：

```text
52582233d44b93e1745873320b206540711b6969656d5edd93936c608eada393
```

用 APK Checker 自带的元数据解析器读取原 APK，得到：

| 字段 | 值 |
| --- | --- |
| 应用名 | VsTV |
| 包名 | `com.vesaa.mytv` |
| 版本 | `2.8.0` / `200800099` |
| 最低 API | 21 |
| 普通启动入口 | `com.vesaa.mytv.activities.MainActivity` |
| 电视启动入口 | `com.vesaa.mytv.activities.MainActivity` |
| APK 原生库架构 | `arm64-v8a`、`armeabi-v7a` |

这份参考 APK 同时声明手机和电视入口，不应因为“普通手机 APK 没有电视图标”就认定它无入口。参考包的结果不能自动视为用户实际文件相同；没有修改／重打包 APK，也没有安装第三方 APK 到宿主系统。

进一步用仓库现有二进制 Manifest 解析函数读取原包，确认 `MainActivity` 为 exported 且未禁用，同一 intent-filter 同时声明 `MAIN`、`LAUNCHER`、`LEANBACK_LAUNCHER`。另有默认禁用的 `ModernLauncherActivity`／`ClassicLauncherActivity`；内部 `LeanbackActivity` 等未导出。因此不能凭静态类名绕过 PackageManager 的启用／导出状态直接启动内部界面。

## 代码审查结果

- 0.2.5 安装只依赖 adb `Success`，未再查目标用户的实际包；打开时依赖 `resolve-activity`。失败信息没有区分包不存在、用户尚未解锁和实际无入口。
- 安装进度文案“已安装到电视桌面”会让用户以 Android TV 是否生成图标判断安装结果；实际应从 APK Checker 的桌面卡片打开。
- 打开命令只带组件 `-n`，没有带与查询一致的 `MAIN`／启动分类；AOSP 的 `Intent.parseCommandArgs` 不会自动为这种 `-n` 形式补齐这些参数。
- `am start -W` 的 `Status: ok` 不能单独证明目标应用已进入前台；AOSP 也可能在未实际切换活动时返回该状态。这是独立的成功判断缺口，不能据此声称已复现用户的入口错误。
- 已核对 Android 16 `resolve-activity --brief` 的组件输出格式符合现有解析器；没有新增数字前缀的证据。现有 bare package 末尾参数在显式 `-a MAIN` 时也不会给 TV 查询暗中叠加 LAUNCHER 分类。

官方源码依据：[PackageManagerShellCommand](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/pm/PackageManagerShellCommand.java)、[Intent](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/core/java/android/content/Intent.java)、[ActivityManagerShellCommand](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/am/ActivityManagerShellCommand.java)。

## 0.2.6 修复实现

- 安装明确绑定目标 AVD 的当前 Android 用户，adb 返回成功后再查询该用户的精确包名；验证失败不产生新的成功标记。
- 打开前唤醒窗口、等待用户 `RUNNING_UNLOCKED`，再检查实际包；区分未安装、尚未解锁、已安装但无可用入口。
- 入口查询明确用户和包名；当单一 resolve 没有得到目标组件时，用 PackageManager 查询同类可用候选。APK 元数据只用于排序，不绕过系统的禁用／导出检查。
- 启动 Intent 带 `MAIN`、实际选中的 TV／普通分类和标准 launcher flags，组件保持安全引用。
- 成功须连续确认目标包位于主显示、当前用户的前台，且锁屏状态明确为否；未知状态不宣告已打开。仅在确认仍为系统 HOME 时至多重试一次，权限窗口、锁屏或其他应用不会被反复抢焦点。
- 无入口时保留有界的包名、用户、查询结果诊断；授权窗口明确提示用户处理，保留窗口及数据。退出／关闭窗口不会继续报告成功。
- UI 提供按卡片模式覆盖重装入口，安装文案明确从 APK Checker 桌面打开。

以上修复覆盖已确认的状态判断和启动参数缺口；VsTV 用户现场的具体原因仍以实际复测和用户反馈为准。

## 验证记录

### 0.2.5 与既有麦动测试

[真实 TV 基线 run 42496701392](https://github.com/ecojust/apk-checker/actions/runs/42496701392)，源码 `b6f11ba`，固定原版麦动 KTV 2.1.8，Linux KVM / Android TV API 36 / x86_64，独立 SDK、AVD、用户数据及 adb 服务；不覆盖用户设备。关闭与本问题无关的登录和键盘探针。

安装及 `pm list packages`、安装标记持久化检查通过，原生 Qt 窗口成功打开，但前台检查失败：系统 `com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity` 位于前台。清理通过。该结果证明现有流程可能将系统权限窗口当作应用已打开，**没有复现 VsTV 的无入口错误**。保留此失败，不通过忽略前台或自动授予未知权限改成通过。

诊断 artifact `13624226194` 已上传；当前环境直接下载该存储返回 HTTP 403，尚未查看截图，不对屏幕图像作结论。

### 0.2.6 工作区界面检查

新增按卡片模式重新安装入口，调用覆盖安装并保留应用数据；不先卸载。安装提示明确从 APK Checker 桌面打开，TV 桌面说明不再承诺所有 APK 都生成图标。

`python3 scripts/verify-install-ui.py` 在 Chromium 浏览器 fixture 中通过 10 组交互检查，无 page error；包括重装保持目标 TV、仅一次安装／不卸载，以及启动失败不显示“已打开”成功通知。初次新增断言错误地按 error 的 alert role 查询成功通知，已改为实际 status role 后通过；生产 UI 未因此回退。此测试不执行 Android 操作。

### 0.2.6 代码回归

独立审查通过。`npm run check`、`npm test`、`npm run build`、`git diff --check` 均通过；9 个测试文件、284 项测试通过。其中 AndroidRuntime 133 项，新增前台状态解析 19 项，较 0.2.5 共增加 44 项。

覆盖当前非零用户安装／查询／启动、成功输出但包不存在、等待解锁、TV 到普通入口回退、多入口候选、空启动输出、系统权限窗口、主屏／其他用户／锁屏未知与冲突、HOME 重试上限、退出取消和原有快照恢复边界。测试中的子进程和 Android 输出是替身，实际 VsTV 测试另列。

### VsTV 真实 Android 复测

固定双 APK profile、下载摘要校验及只读诊断已提交 [8a1ca32](https://github.com/ecojust/apk-checker/commit/8a1ca3264a7d8aee2d57384a6b6a82331fbe9324)。该提交仅修改 smoke 文件，生产代码仍是 0.2.5；VSTV 采用上述原始 ARM 包，在 Linux TV 镜像的 ARM 转译支持下运行。

[VsTV 0.2.5 基线 run 42497519047](https://github.com/ecojust/apk-checker/actions/runs/42497519047)已启动。不会授予麦动专属权限，不执行登录／键盘探针，不添加直播源；仍要求实际包存在、原生窗口、目标包前台及清理成功。收集当前用户、解锁状态、包存在、TV／普通 resolve 与 query 原始结果和前台摘录，保留完整失败诊断。

当前仍在执行，尚无该包通过完整 Android 安装／冷启动／打开的结论；用户 Mac 的最终 VsTV 打开也未确认。

交接与用户原话见 [history](../../history/2026-11-08-001.md)。
