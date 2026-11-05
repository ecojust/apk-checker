# macOS 0.1.1 打包修复与验收

用户反馈 ARM 客户端提示「已损坏」。原配置关闭了 `CSC_IDENTITY_AUTO_DISCOVERY`，没有明确签名身份；electron-builder 会跳过对修改后 Electron 应用包的重新签名。旧流程只确认安装包生成，未验证包内签名或原生启动，不能排除失效签名问题。

0.1.1 明确使用 ad-hoc 身份 `-` 对应用和辅助程序签名，配置 Electron JIT 所需权限、hardened runtime 和严格签名验证；PR 构建也启用签名。**这不是 Developer ID 签名，也没有进行 Apple 公证。**

## 已执行验证

- 来源提交：[`13bb0bd`](https://github.com/ecojust/apk-checker/commit/13bb0bd)。
- [修复版 CI](https://github.com/ecojust/apk-checker/actions/runs/42041997570)：macOS Apple Silicon、macOS Intel、Windows x64 均通过测试、生产构建和安装包生成。
- 两种 Mac 均在与安装包架构相同的原生 macOS 主机上执行 `scripts/verify-macos-package.mjs`，没有通过跨架构构建代替启动验收。

Mac 验证包含：

1. `hdiutil verify` 检查实际生成的 DMG，并只读挂载。
2. 对 DMG 内 `.app` 执行 `codesign --verify --deep --strict`，核验 ad-hoc 签名和必要权限。
3. 用 `ditto` 复制应用，检查复制后的签名和 Mach-O 架构。
4. 使用独立临时配置目录启动打包后的应用；通过真实 renderer 验证 React 界面、preload IPC 和 Node 隔离，并保存截图。
5. 启动后再次检查包内签名，确保应用未修改自身签名资源。
6. 生成安装包 SHA-256，附带 `mac-verification.json`、日志和截图。

## 安装包

- [macOS Apple Silicon / ARM64](https://github.com/ecojust/apk-checker/actions/runs/42041997570/artifacts/13423390568)
- [macOS Intel / x64](https://github.com/ecojust/apk-checker/actions/runs/42041997570/artifacts/13422297284)
- [Windows x64](https://github.com/ecojust/apk-checker/actions/runs/42041997570/artifacts/13423190604)

这些是保留 14 天的 CI artifacts，不是 GitHub Release。解压后包含对应安装包及 `SHA256SUMS.txt`。

## 分发边界

本次验证证明包内签名、DMG 完整性和原生启动通过，**不证明用户下载后的 Gatekeeper 放行或 Apple 公证通过**。验证脚本会单独记录 `spctl` 评估；ad-hoc 包仍可能需要用户按本仓库 [README 的 macOS 安装说明](../../README.md)批准这份应用。

用户本机安装及 Android APK 运行仍需实际环境验收；Windows 本轮验证的是构建与安装包生成，没有声称执行了 Windows 原生界面启动。未对系统做全局 Gatekeeper 关闭，不需要用户提供签名密钥才能复查上述 ad-hoc 构建。
