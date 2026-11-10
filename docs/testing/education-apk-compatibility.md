# 教育 APK 安装与启动对照（2026-11-10）

儿歌多多原包在 64 位 TV 镜像中因 ABI 不匹配安装失败；宝宝趣学原包安装成功，但在首页数据解析和版本检查中触发空对象异常后退出。这是两个不同阶段的问题。此次实际 Android 测试宿主为 Linux，未在用户的 Apple Silicon Mac 上重现，因此不能认定宝宝在用户机器上一定是同一异常。

## 固定输入与环境

- 测试源码：[`d864145a7637a6501e7e282b48d599364d771410`](https://github.com/ecojust/apk-checker/commit/d864145a7637a6501e7e282b48d599364d771410)。生产代码仍为 0.2.6；本次只扩展固定 smoke profile 与有界诊断。
- 原包来源：pureTV 固定提交 [`6a2f865aef930ecea868ad185fba6ad59f824b80`](https://github.com/ecojust/pureTV/tree/6a2f865aef930ecea868ad185fba6ad59f824b80/fork/education)。下载器校验 SHA256，不重打包、不改签名、不加入本仓库。
- 两次均使用独立、全新私有 AVD／SDK／ADB 回环端口；Ubuntu 22.04 KVM、Android TV API36，`ro.product.cpu.abilist=x86_64,arm64-v8a`，native bridge 为 `libndk_translation.so`。原始设备属性在各自 diagnostics 中。
- 不授予预置权限，不操作协议、账号或登录，不执行麦动专属探针；结束确认私有进程均已退出。

| 原包 | SHA256 | 实际结果 |
| --- | --- | --- |
| 儿歌多多TV 1.3.1.0／1310 | `f02e205460dc68af3a8161feb042737b175beea64073d03502fb113e155de6f5` | 安装失败，`INSTALL_FAILED_NO_MATCHING_ABIS`／`res=-113`；当前用户包列表不存在此包。 |
| 宝宝趣学 3.0.1／3 | `41ea8a44d3febece6284b10c05ff7ddd08dbd8f5555253ffe661dc40a2c67121` | 安装及持久化标记验证成功；打开后进程消失，返回 TV 系统桌面；crash buffer 中有该包的两条 Java 致命异常。 |

## 宝宝趣学崩溃证据

实际 PackageManager 返回普通启动入口 `com.wn31.cuteSpark/.HomeActivity`，无 `LEANBACK_LAUNCHER` 入口。APK Checker 成功回退普通入口；这不是“包未安装”或“没有任何可启动入口”。

2026-11-10 12:18:21 的完整 [crash buffer](evidence/education-2026-11-10/baby-fun-learning/logcat-crash.txt) 显示同一进程 `com.wn31.cuteSpark`（PID1490）：

- `Thread-6`：`NullPointerException`，对空的 `AllJsonData` 调用 `getChildrenAllVideo()`，位置 `AndroidUtil.noBoxParseJson(AndroidUtil.java:22)`。
- `Thread-7`：`NullPointerException`，对空的 `UpdateManager$ReleaseMetadataJson` 调用 `getElements()`，位置 `UpdateManager.getRemoteVersionCode(UpdateManager.java:3)`。

这能确认此轮运行的直接崩溃位置，不能说明数据为何为空。未取得 HTTP 响应、业务源码或用户 Mac 的同一崩溃日志，不能断言远端停服、网络阻断、加固壳故障或 Android 16 不兼容。未修改第三方原包。

用户随后说“好像就是说桌面图标不显示啥的”。代码中确有相符的固定说明：`src/App.tsx` 在桌面存在电视安装卡片时显示“从这里打开应用；电视系统桌面可能不会显示手机应用图标。”；`electron/android.ts` 在 TV 入口缺失时提示回退普通入口。这些文字本身不是错误，但尚不能确定就是用户看到的原文，也不抹去用户最初的闪退报告。

## 工作流与证据

| 对照 | 工作流／job | 结果与保留证据 |
| --- | --- | --- |
| 儿歌多多 | [42814117728](https://github.com/ecojust/apk-checker/actions/runs/42814117728)／129822706626 | 首轮 failure；[原始 annotations](evidence/education-2026-11-10/ergeduoduo/annotations-129822706626.json)、[重组诊断](evidence/education-2026-11-10/ergeduoduo/diagnostics.json)、[workflow 元数据](evidence/education-2026-11-10/ergeduoduo/workflow.json)。未安装，不执行启动或卸载；私有进程已清理。 |
| 宝宝趣学 | [42814114176](https://github.com/ecojust/apk-checker/actions/runs/42814114176)／129822693919 | 首轮 failure；[原始 annotations](evidence/education-2026-11-10/baby-fun-learning/annotations-129822693919.json)、[重组诊断](evidence/education-2026-11-10/baby-fun-learning/diagnostics.json)、[workflow 元数据](evidence/education-2026-11-10/baby-fun-learning/workflow.json)。失败后卸载、清除测试标记及私有进程清理通过。 |

crash buffer 在确认私有 AVD 身份后、较慢的 package/window 诊断之前采集，完整文本保存在 artifact 中；有界副本通过 checks API 保存。此次宝宝 crash 文本 `truncated=false`，仓库的 `logcat-crash.txt` 精确恢复自该原始 JSON 字段。其余分段 notice 按 diagnosticId/index 重组，并核对总片段数。

两个原始失败均保留，没有重试或把失败改成通过。额外诊断命令 `cmd user is-user-unlocked` 在该镜像不支持，其原始错误保留；生产及有效诊断 `am get-started-user-state` 均得到 `RUNNING_UNLOCKED`，这不是应用异常来源。

Artifacts 已上传：宝宝 [13762928805](https://github.com/ecojust/apk-checker/actions/runs/42814114176/artifacts/13762928805)、儿歌 [13764163087](https://github.com/ecojust/apk-checker/actions/runs/42814117728/artifacts/13764163087)。本地下载宝宝 artifact 遇到存储 HTTP403，`gh run view --job --log` 返回空内容；未拿到 general logcat、完整 summary 或截图，未目视画面，不能从而判断 HTTP 失败原因。证据来自可读的 GitHub checks API，不把存储访问问题计作 APK 的网络故障。

## 已完成与仍需信息

本地 `npm run check`、`git diff --check` 和 workflow YAML 解析通过；两份固定 APK 实际下载并校验。真实 Android 两轮分别定位安装 ABI 拒绝和应用自身空对象崩溃。没有修改生产实现、合并分支、生成新安装包或发布 Release。

后续需要宝宝 Mac 现场 crash log 与原始服务响应，或上游修复版本，才能判断并解决用户设备上的退出；当前不推荐反复安装同一原包作为修复。若只看到桌面图标提示，应从 APK Checker 的已安装电视卡片打开，再区分是否实际退出。
