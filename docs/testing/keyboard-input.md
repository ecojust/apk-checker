# 电脑键盘与完整文字输入

用户描述：在电视软件输入框中用电脑实体键盘输入，确认候选／按回车后文字没有进入 Android；没有使用 Android 虚拟键盘。尚未确认是否仅中文输入法失败，不能把该报告简化为表单缺少回车提交。

## 已确认的通道限制

0.2.1 的 scrcpy 5.0.1 默认 SDK 键盘模式使用 `KeyCharacterMap.getEvents` 将字符转换为 Android 按键。不能映射的字符会被丢弃；宿主输入法候选文字可见，不证明 Android 收到文本。`--prefer-text` 仍经过该转换，UHID 不转发宿主文本事件，不能直接解决宿主中文提交。

- [官方键盘支持范围](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/keyboard.md)
- [服务端字符注入](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/control/Controller.java)
- [UHID 不转发 text input](https://github.com/Genymobile/scrcpy/blob/v5.0.1/app/src/uhid/keyboard_uhid.c)

公开 Emulator Qt 源码也不能证明完整转发宿主 IME。原生窗口修复安全弹窗黑屏，与 Unicode 输入是两个独立问题。方向键有效也不能证明文字提交已通过。

## 0.2.3 处理方案与待验收范围

桌面新增“输入文字”入口，先在模拟器点中目标输入框，再在电脑输入框使用实体键盘和系统输入法写好文字，显式发送。输入法组合期间的 Enter 只确认候选；普通 Enter 发送，Shift+Enter 换行，发送不附加 Android Enter、不自动提交搜索或登录。文字仅保存在当前弹窗内存，关闭后清空，不写入历史或日志。

完整 UTF-8 文本通过模拟器官方认证回环接口写入该实例的剪贴板，再向已校验的自有模拟器发送一次粘贴按键；不安装 Android 输入法、不修改 APK、不使用 `adb input text` 拼接 Unicode。后台必须校验自有进程、AVD 和 serial，不启动未打开的设备，也不向外部／真实设备发送内容。实现已通过本地回归与构建；实际 Android 和目标 Mac 验证另行记录。

官方 `setClipboard` 成功仅表示已排队，`getClipboard` 返回宿主缓存；它们都不是 Android 输入框已接收的确认。产品只提示请求已发送，测试则必须读取实际输入框核对文本。不会自动重复粘贴，以免插入重复内容。

## 验证计划

- UI 使用实际浏览器交互检查中文组合确认、再次 Enter 发送、重复提交阻止、手机／电视模式绑定和错误处理；界面 fixture 不代表 Android 成功。
- 干净 Linux CI AVD 使用原版麦动 2.1.8 的主搜索框，检查宿主 X11 实体键码路径的 `abc123`，再检查完整文字通道的中文、英文、数字、引号和连续两段不同文本。Emoji 的 Android 结果独立记为待验，不把协议层编码成功作为 guest 验证。账号表单保持空白，不提交任何凭据。
- 原生 Mac／Windows 安装包、Linux Android 集成、用户 Mac 实际键盘输入分别记录。Linux 键盘探针不能替代 macOS 输入法实测。

实际执行结果将在下方追加；本节不是测试通过声明。

## 已执行的界面检查

Chromium 1040×720 中已实际执行六组交互：组合输入确认不发送、再次 Enter 单次发送与忙态、失败保留文字／成功关闭清空、Shift+Enter 与目标模式冻结、UTF-8 长度／取消／焦点循环、设备未打开提示。页面错误数为 0，截图已人工查看。这使用 UI API fixture，未连接 Android，也不代表 macOS 系统输入法已实测。

复现入口为 [verify-text-input-ui.py](../../scripts/verify-text-input-ui.py)。测试主机需单独具备 Python Playwright 和 Chromium，启动 `npm run dev:web` 后执行 `python3 scripts/verify-text-input-ui.py`；可用 `APK_UI_URL`、`APK_CHROMIUM_PATH`、`APK_UI_SCREENSHOT` 指定测试地址、浏览器和截图路径。这些仅是开发测试工具，不是客户端运行前提。

## 后端本地验证

全量 212 项测试通过后，新增 4 项协议回归，32 项协议定向测试及类型检查再次通过，当前共 **216 项**测试已覆盖；`npm run build`（含 TypeScript）通过；独立代码审核未发现阻断。运行时回归覆盖仅自有原生窗口、AVD／serial／认证端口／目录匹配、Windows launcher 子 PID 差异、模式隔离、关窗／退出取消和单次粘贴。实际本地 HTTP/2 服务检查 UTF-8 protobuf、gRPC 帧与状态、认证、长度上限、异常脱敏、连接释放和有界缓存读回轮询；它不是 Android 接收证明。

发送只执行一次 setClipboard；缓存尚未更新时只轮询 getClipboard，总时限有界。匹配后再次确认目标在线，再粘贴一次；不会重发粘贴或发送 Enter。本地结果不替代下面待执行的真实搜索框检查。

## 首轮 Android 输入检查（保留失败）

`4e11d39` 的[run 42068324515](https://github.com/ecojust/apk-checker/actions/runs/42068324515) 两组均完成安装、原生窗口、卸载与私有进程清理，但整体失败。手机的三条输入路径在 `search_input.focused` 检查处停止，**没有调用生产 gRPC 输入接口**；因此不能把它报告为字符传输失败或成功。原版源码的 `prepareTvFocusableTree`／`TvFocusStyler.install` 会设置 `isFocusableInTouchMode=false`，正在用有界 Tab 导航核实真实键盘焦点。电视被 Android 的旧 targetSdk 提示遮住，尚未进入搜索框检查。

后续探针只确认已知系统提示的 OK 按钮，并在发送前要求搜索框实际获得焦点；不会删除焦点断言或把方向键注入当作成功。Emoji 的 Android 检查明确未执行。

0.2.3 三平台原生构建已通过，源提交 `4e11d39`，具体安装包及平台检查见[原生包验收](managed-runtime.md#023-原生安装包验收)。`3b351c2` 的第二轮手机检查已实证：Tab 导航后搜索框获得键盘焦点，宿主 XTest `abc123` 严格读回通过；后续虚拟清空按钮点击未清空，生产文字发送未执行。下一轮改用宿主 Ctrl+A／Backspace，并优先验证生产文字路径，仍保留清空与输入结果断言。
