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

[VsTV 0.2.5 基线 run 42497519047](https://github.com/ecojust/apk-checker/actions/runs/42497519047)已全部通过。没有授予麦动专属权限，不执行登录／键盘探针，不添加直播源；实际包存在、原生窗口、目标包前台及清理均通过。

完整重组 GitHub checks 的三段诊断，保存为[基线证据](evidence/vstv-0.2.5-baseline.json)。冷启动后当前用户为 `0`、`RUNNING_UNLOCKED`，`pm list packages --user 0` 精确返回目标包；TV 与普通入口均为 `com.vesaa.mytv/.activities.MainActivity`；主显示实际前台为同包的 `.activities.LeanbackActivity`。按键后的前台与清理也通过。只读额外探针 `cmd user is-user-unlocked` 在此镜像不支持，原样记为错误；解锁结论依据实际成功的 `am get-started-user-state`。

报告 artifact [13624352004](https://github.com/ecojust/apk-checker/actions/runs/42497519047/artifacts/13624352004) 已生成。checks 诊断已读取，截图未人工查看；`gh run view --log` 当次虽退出 0 但输出为空，不把它当已取得完整日志。

**未在基线复现用户的“无启动入口”故障。** 以上是 Linux API 36 x86_64＋ARM 转译环境中对官方 ARM 2.8.0 原包的结果，不等于用户 Apple Silicon Mac、实际版本或已有 AVD 的验收。

0.2.6 修复源码 [ce99f7d](https://github.com/ecojust/apk-checker/commit/ce99f7d896ccb660e7f3bec32ca1e67aa8c0cdea)已推送。[三平台安装包构建 42497825685](https://github.com/ecojust/apk-checker/actions/runs/42497825685)全部通过；同一 SHA 的重复 PR 构建已取消，未发布新 Release。

[同原包 TV 验收 42497849904 的第一次尝试](https://github.com/ecojust/apk-checker/actions/runs/42497849904/attempts/1)在安装阶段失败，未进入入口／前台验证：`adb install --user 0 -r` 输出 `Performing Streamed Install` 后退出 1，`failed to install` 没有给出 Android 错误原因；后续未发现可读目标设备，缺少 logcat／入口诊断。固定 APK 摘要正确，准备通过，清理后无私有进程残留。

原始失败保存在[第一次尝试证据](evidence/vstv-0.2.6-attempt1-failed.json)，不能据此断定参数有误、ABI 不兼容或入口修复失败。因缺少具体错误，在同一源码、不改 APK／检查规则的条件下进行一次重跑；首次失败继续保留。

失败后的独立检查确认：Android 36 的 `makeInstallParams` 在同一选项循环处理 `--user` 与 `-r`，顺序有效；固定目录中 Platform-Tools 37.0.1-15733141 的官方归档经摘要校验，其帮助将额外安装选项交给 `pm`。[adb 上游安装实现](https://android.googlesource.com/platform/packages/modules/adb/+/refs/heads/main/client/adb_install.cpp)的流式路径在未读到安装状态文本时可产生这种空错误尾；该源码是上游 main，不冒充二进制的精确发布 commit。代码清理仅在安装失败后执行，此次不是三分钟超时。具体断开原因仍未确定。

[第二次尝试](https://github.com/ecojust/apk-checker/actions/runs/42497849904/attempts/2)全部通过，完整 checks 结果保存在[第二次尝试证据](evidence/vstv-0.2.6-attempt2-passed.json)：实际安装 67.781 秒（含首次启动）、原生窗口与前台检查 56.016 秒（含冷启动）、按键后前台 4.617 秒、卸载 0.793 秒，退出后无私有进程残留。当前用户 0／RUNNING_UNLOCKED、精确包存在、两个入口及主屏 LeanbackActivity 前台均确认；没有运行媒体播放或音频测试。

新报告 artifact [13624458149](https://github.com/ecojust/apk-checker/actions/runs/42497849904/artifacts/13624458149) 与首轮失败 artifact 均保留。复测通过不等于两轮都通过，也不证明用户 Mac 的具体故障原因已定位；用户所用 VsTV 的完整文件名／版本仍待确认。

## 0.2.6 测试包与使用

[下载 Apple Silicon Mac 0.2.6 测试包](https://github.com/ecojust/apk-checker/actions/runs/42497825685/artifacts/13624372430)（需登录 GitHub，artifact 保留至 2026-11-22 UTC）。

1. 完全退出旧 APK Checker 与其模拟器，解压下载文件并打开 `APK Checker-0.2.6-mac-arm64.dmg`，替换「应用程序」中的旧版。
2. 在 **APK Checker 自己的桌面**找到 VsTV 的电视卡片，选择「更多操作 → 重新安装到电视（保留数据）」。
3. 安装完成后点「打开」。若窗口出现系统授权或解锁提示，先完成该操作；若仍失败，保留新版本显示的具体包名、用户及入口诊断。

ARM 安装包来自生产提交 `ce99f7d`，原生 job `128783881314` 的 284 项测试、DMG 完整性、挂载／复制后 ad-hoc 签名、客户端启动与 IPC 检查通过。原始 job 日志中的 DMG 摘要为：

```text
0c8f023e1cad63787f66907e1022e3c0bebbc0f7be41fe3ddb2aa126b864a1c7  APK Checker-0.2.6-mac-arm64.dmg
```

GitHub API 另核对 artifact 的源 SHA 与 ZIP 摘要；本地未下载并重算整个 DMG。Mac 尚未公证；客户端构建检查没有启动 Mac Android TV，实际 Android 运行结果仅限上述 Linux 验收。

同源码[Intel Mac 测试包](https://github.com/ecojust/apk-checker/actions/runs/42497825685/artifacts/13623768447)和[Windows 测试包](https://github.com/ecojust/apk-checker/actions/runs/42497825685/artifacts/13624282734)也已生成。代码已推送 [PR #2](https://github.com/ecojust/apk-checker/pull/2)，尚未合并／发布 Release，公开 0.2.4 资产没有改变。

交接与用户原话见 [history](../../history/2026-11-08-001.md)。
