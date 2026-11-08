import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import {
  AndroidRuntime,
  parseDevices,
  parseResolvedActivity,
  validatePackageName,
} from "../electron/android";
import { displayCommand } from "../electron/display";
import type { LibraryApp, Settings } from "../src/shared/types";

const clipboardMock = vi.hoisted(() => vi.fn());
vi.mock("../electron/emulator-clipboard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../electron/emulator-clipboard")>()),
  setEmulatorClipboard: clipboardMock,
}));

const processMocks = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => processMocks);

const app: LibraryApp = {
  id: "test",
  name: "示例应用",
  packageName: "org.example.app",
  versionName: "1.0",
  versionCode: "1",
  size: 1000,
  importedAt: "2026-01-01T00:00:00Z",
  fileName: "sample.apk",
  installed: {
    phone: { avd: "Phone_API_35", installedAt: "2026-01-01T00:00:00Z" },
    tv: { avd: "TV_API_35", installedAt: "2026-01-01T00:00:00Z" },
  },
};

function foregroundDump(component: string, userId = 0, displayId = 0, locked = false): string {
  return `Display #${displayId} (activities from top to bottom):\n  topResumedActivity=ActivityRecord{abc u${userId} ${component} t3}\nKeyguardController:\n  mKeyguardShowing=${locked}\n  mAodShowing=false\n`;
}

function fakeChild(autoClose = true): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  child.stderr = new EventEmitter() as ChildProcess["stderr"];
  child.stdout = new EventEmitter() as ChildProcess["stdout"];
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;
  Object.defineProperties(child, {
    pid: { value: 12345 },
    exitCode: { get: () => exitCode },
    signalCode: { get: () => signalCode },
  });
  child.on("exit", (code, signal) => {
    exitCode = code;
    signalCode = signal || null;
    if (autoClose) queueMicrotask(() => child.emit("close", code, signal));
  });
  child.kill = vi.fn((signal: NodeJS.Signals | number = "SIGTERM") => {
    queueMicrotask(() => child.emit("exit", null, signal));
    return true;
  });
  return child;
}

describe("Android command parsing", () => {
  it("ignores daemon messages and keeps device state", () => {
    expect(
      parseDevices(
        "* daemon started successfully\nList of devices attached\nemulator-5554\tdevice\nemulator-5556 offline\nABC123 unauthorized\n",
      ),
    ).toEqual([
      { serial: "emulator-5554", state: "device", avd: "" },
      { serial: "emulator-5556", state: "offline", avd: "" },
      { serial: "ABC123", state: "unauthorized", avd: "" },
    ]);
  });
  it("accepts only activities from the requested package", () => {
    expect(
      parseResolvedActivity(
        "priority=0\norg.example.app/.Main$Inner\n",
        "org.example.app",
      ),
    ).toBe("org.example.app/.Main$Inner");
    expect(
      parseResolvedActivity("com.android/.ResolverActivity", "org.example.app"),
    ).toBeUndefined();
    expect(
      parseResolvedActivity("org.example.app/.Main;reboot", "org.example.app"),
    ).toBeUndefined();
    expect(
      parseResolvedActivity("No activity found", "org.example.app"),
    ).toBeUndefined();
  });
  it.each([
    "org.example.app;reboot",
    "org.example.$(id)",
    "../app",
    "",
    "-r",
    "app",
  ])("rejects unsafe package name %s", (value) => {
    expect(() => validatePackageName(value)).toThrow("包名无效");
  });
});

describe("AndroidRuntime", () => {
  let directory: string;
  let settings: Settings;
  let runtime: AndroidRuntime;
  let apkPath: string;
  let scrcpy: ChildProcess;
  let output: (args: string[]) => string;
  let autoExitAfterEmulatorKill: boolean;
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  const exe = (name: string) =>
    process.platform === "win32" ? `${name}.exe` : name;

  beforeEach(async () => {
    vi.resetAllMocks();
    clipboardMock.mockResolvedValue(undefined);
    autoExitAfterEmulatorKill = true;
    directory = await mkdtemp(join(tmpdir(), "apk checker runtime "));
    settings = {
      sdkPath: join(directory, "sdk"),
      scrcpyPath: join(directory, exe("scrcpy")),
      phoneAvd: "Phone_API_35",
      tvAvd: "TV_API_35",
      defaultMode: "phone",
    };
    await Promise.all(
      [
        "platform-tools",
        "emulator",
        "build-tools/9.0.0",
        "build-tools/35.0.0",
      ].map((path) => mkdir(join(settings.sdkPath, path), { recursive: true })),
    );
    await Promise.all(
      [
        join(settings.sdkPath, "platform-tools", exe("adb")),
        join(settings.sdkPath, "emulator", exe("emulator")),
        join(settings.sdkPath, "build-tools/9.0.0", exe("aapt")),
        join(settings.sdkPath, "build-tools/35.0.0", exe("aapt2")),
        settings.scrcpyPath,
      ].map((path) => writeFile(path, "", { mode: 0o755 })),
    );
    apkPath = join(directory, "sample with spaces.apk");
    await writeFile(apkPath, "test");
    vi.stubEnv("ANDROID_AVD_HOME", join(directory, "avds"));
    runtime = new AndroidRuntime();
    scrcpy = fakeChild();
    processMocks.spawn.mockImplementation(() => {
      queueMicrotask(() =>
        scrcpy.stdout?.emit("data", Buffer.from("INFO: Texture: 1080x1920\n")),
      );
      return scrcpy;
    });
    output = (args) => {
      if (args[0] === "-list-avds") return "Phone_API_35\nTV_API_35\n";
      if (args[0] === "devices")
        return "List of devices attached\nphysical-device\tdevice\nemulator-5554\tdevice\nemulator-5556\tdevice\n";
      if (args.includes("emu"))
        return `${args[1] === "emulator-5554" ? "Phone_API_35" : "TV_API_35"}\nOK\n`;
      if (args.includes("getprop")) return "1\n";
      if (args.includes("get-current-user")) return "0\n";
      if (args.includes("get-started-user-state")) return "RUNNING_UNLOCKED\n";
      if (args.includes("dumpsys")) return foregroundDump("org.example.app/.Main$Inner");
      if (args.includes("resolve-activity"))
        return args.includes("android.intent.category.HOME") ? "com.android.launcher/.Home\n" : "org.example.app/.Main$Inner\n";
      if (args.includes("query-activities")) return "No activities found\n";
      if (args.includes("start")) return "Status: ok\n";
      if (args.includes("packages")) return "package:org.example.app\n";
      return "Success\n";
    };
    processMocks.execFile.mockImplementation(
      (
        _file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void,
      ) => {
        callback(null, output(args), "");
        if (
          autoExitAfterEmulatorKill &&
          args.includes("emu") &&
          args.includes("kill")
        ) {
          queueMicrotask(() => scrcpy.emit("exit", 0, null));
        }
      },
    );
  });
  afterEach(async () => {
    try {
      // Release mocked processes even if a shutdown assertion failed before it
      // advanced the fake clock. This keeps the next test's platform isolated.
      if (scrcpy.exitCode === null && scrcpy.signalCode === null) {
        scrcpy.emit("exit", 0, null);
      }
      await runtime.dispose().catch(() => undefined);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      vi.useRealTimers();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("discovers newest SDK build tools numerically and lists named devices", async () => {
    expect(await runtime.getAaptPath(settings)).toBe(
      join(settings.sdkPath, "build-tools/35.0.0", exe("aapt2")),
    );
    const status = await runtime.getStatus(settings);
    expect(status).toMatchObject({
      sdkFound: true,
      adbFound: true,
      emulatorFound: true,
      aaptFound: true,
      scrcpyFound: true,
      avds: ["Phone_API_35", "TV_API_35"],
      issues: [],
    });
    expect(
      status.devices.find((device) => device.serial === "emulator-5556")?.avd,
    ).toBe("TV_API_35");
    expect(status.devices.map((device) => device.serial)).toEqual([
      "emulator-5554",
      "emulator-5556",
    ]);
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("physical-device"),
      ),
    ).toBe(false);
  });

  it("reports an explicitly missing SDK rather than silently choosing another SDK", async () => {
    const status = await runtime.getStatus({
      ...settings,
      sdkPath: join(directory, "missing-sdk"),
    });
    expect(status.sdkFound).toBe(false);
    expect(status.adbFound).toBe(false);
    expect(status.issues.join(" ")).toContain("Android SDK");
  });

  it("installs into the selected AVD with literal path arguments", async () => {
    const result = await runtime.install(app, apkPath, "tv", settings, vi.fn());
    expect(result).toEqual({ avd: "TV_API_35" });
    expect(processMocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      ["-s", "emulator-5556", "install", "--user", "0", "-r", apkPath],
      expect.objectContaining({ timeout: 180000, windowsHide: true }),
      expect.any(Function),
    );
    expect(processMocks.spawn).not.toHaveBeenCalled();
  });

  it("does not mark a failed installation successful", async () => {
    const normal = output;
    output = (args) =>
      args.includes("install")
        ? "Failure [INSTALL_FAILED_NO_MATCHING_ABIS]"
        : normal(args);
    await expect(
      runtime.install(app, apkPath, "phone", settings, vi.fn()),
    ).rejects.toThrow("INSTALL_FAILED_NO_MATCHING_ABIS");
  });

  it("does not accept install Success unless the exact package exists for the current user", async () => {
    const normal = output;
    output = (args) => args.includes("packages") ? "package:org.example.app.other\n" : normal(args);
    const progress = vi.fn();
    await expect(runtime.install(app, apkPath, "tv", settings, progress)).rejects.toThrow("重新安装（保留数据）");
    expect(progress.mock.calls.some(([message]) => message.includes("已安装到"))).toBe(false);
  });

  it.each(["", "-1", "10\n0", "1;id", "999999999999999999999"])("rejects an invalid current Android user %j", async (user) => {
    const normal = output;
    output = (args) => args.includes("get-current-user") ? user : normal(args);
    await expect(runtime.install(app, apkPath, "tv", settings, vi.fn())).rejects.toThrow("当前 Android 用户");
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("install"))).toBe(false);
  });

  it("binds installation, package checks, resolution and launch to the same nonzero Android user", async () => {
    nativeRuntimeFixture();
    const normal = output;
    output = (args) => args.includes("get-current-user") ? "10\n" : args.includes("dumpsys") ? foregroundDump("org.example.app/.Main$Inner", 10) : normal(args);
    await runtime.install(app, apkPath, "tv", settings, vi.fn());
    await runtime.launch(app, "tv", settings, vi.fn());
    const commands = processMocks.execFile.mock.calls.map((call) => call[1] as string[]);
    for (const command of commands.filter((args) => args.includes("install") || args.includes("packages") || args.includes("resolve-activity") || args.includes("start"))) {
      expect(command.slice(command.indexOf("--user"), command.indexOf("--user") + 2)).toEqual(["--user", "10"]);
    }
  });

  it("reports a stale installation before resolving or starting an absent package", async () => {
    const fixture = nativeRuntimeFixture();
    const normal = output;
    output = (args) => args.includes("packages") ? "" : normal(args);
    await expect(runtime.launch(app, "tv", settings, vi.fn())).rejects.toThrow("未在模拟器当前用户中找到");
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("resolve-activity") || call[1].includes("start"))).toBe(false);
    expect(fixture.children[0].child.exitCode).toBeNull();
  });

  it("waits for the Android user to unlock before querying installed packages and launcher activities", async () => {
    nativeRuntimeFixture();
    const normal = output;
    let userChecks = 0;
    output = (args) => {
      if (args.includes("get-started-user-state")) return ++userChecks < 3 ? "RUNNING_UNLOCKING\n" : "RUNNING_UNLOCKED\n";
      if (args.includes("packages") || (args.includes("resolve-activity") && !args.includes("android.intent.category.HOME"))) expect(userChecks).toBeGreaterThanOrEqual(3);
      return normal(args);
    };
    await runtime.launch(app, "tv", settings, vi.fn());
    expect(userChecks).toBe(3);
  });

  it("leaves a locked Android user for the user to unlock without guessing that the package is missing", async () => {
    const fixture = nativeRuntimeFixture();
    const normal = output;
    output = (args) => args.includes("get-started-user-state") ? "RUNNING_LOCKED\n" : normal(args);
    vi.useFakeTimers();
    const opening = runtime.launch(app, "tv", settings, vi.fn());
    const rejected = expect(opening).rejects.toThrow("尚未解锁");
    await vi.waitFor(() => expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("get-started-user-state"))).toBe(true));
    await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("packages") || call[1].includes("start"))).toBe(false);
    expect(fixture.children[0].child.exitCode).toBeNull();
  });

  it("rejects invalid packages before any Android command", async () => {
    await expect(
      runtime.install(
        { ...app, packageName: "org.example.app;id" },
        apkPath,
        "phone",
        settings,
        vi.fn(),
      ),
    ).rejects.toThrow("包名无效");
    expect(processMocks.execFile).not.toHaveBeenCalled();
  });

  it("rejects missing APKs before booting a device", async () => {
    await expect(
      runtime.install(
        app,
        join(directory, "missing.apk"),
        "phone",
        settings,
        vi.fn(),
      ),
    ).rejects.toThrow("APK 文件不存在");
    expect(processMocks.execFile).not.toHaveBeenCalled();
  });

  it("prevents phone and TV sharing the same configured AVD", async () => {
    await expect(
      runtime.install(
        app,
        apkPath,
        "phone",
        { ...settings, tvAvd: settings.phoneAvd },
        vi.fn(),
      ),
    ).rejects.toThrow("两个不同");
    expect(processMocks.execFile).not.toHaveBeenCalled();
  });

  it("checks that a television selection uses a TV system image", async () => {
    const avdDirectory = join(directory, "avds", "TV_API_35.avd");
    await mkdir(avdDirectory, { recursive: true });
    await writeFile(
      join(avdDirectory, "config.ini"),
      "tag.id=google_apis\nhw.device.name=pixel_8\n",
    );
    await expect(
      runtime.install(app, apkPath, "tv", settings, vi.fn()),
    ).rejects.toThrow("不是 Android TV");
    expect(processMocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects stale install records after a configured device changes", async () => {
    await expect(
      runtime.launch(
        app,
        "phone",
        { ...settings, phoneAvd: "Other_Phone" },
        vi.fn(),
      ),
    ).rejects.toThrow("尚未安装");
    expect(processMocks.execFile).not.toHaveBeenCalled();
  });

  it("opens TV apps with LEANBACK intent and a dedicated interactive scrcpy window", async () => {
    await runtime.launch(app, "tv", settings, vi.fn());
    expect(processMocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["android.intent.category.LEANBACK_LAUNCHER"]),
      expect.any(Object),
      expect.any(Function),
    );
    expect(processMocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      [
        "-s",
        "emulator-5556",
        "shell",
        "am",
        "start",
        "-W",
        "--user",
        "0",
        "-a",
        "android.intent.action.MAIN",
        "-c",
        "android.intent.category.LEANBACK_LAUNCHER",
        "-f",
        "0x10200000",
        "-n",
        "'org.example.app/.Main$Inner'",
      ],
      expect.any(Object),
      expect.any(Function),
    );
    expect(processMocks.spawn).toHaveBeenCalledWith(
      displayCommand(settings.scrcpyPath, []).file,
      expect.arrayContaining([
        "--serial",
        "emulator-5556",
        "--window-title",
        "示例应用 · 电视模式 · APK Checker",
      ]),
      expect.objectContaining({
        env: expect.objectContaining({
          ADB: join(settings.sdkPath, "platform-tools", exe("adb")),
        }),
      }),
    );
    runtime.dispose();
    expect(scrcpy.kill).toHaveBeenCalledOnce();
  });

  it("falls back explicitly when a TV application only has a phone launcher", async () => {
    const normal = output;
    output = (args) =>
      args.includes("android.intent.category.LEANBACK_LAUNCHER")
        ? "No activity found\n"
        : normal(args);
    const progress = vi.fn();
    await runtime.launch(app, "tv", settings, progress);
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining("没有电视启动入口"),
    );
    expect(processMocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["android.intent.category.LAUNCHER"]),
      expect.any(Object),
      expect.any(Function),
    );
    const start = processMocks.execFile.mock.calls.find((call) => call[1].includes("start"))![1];
    expect(start).toContain("android.intent.category.LAUNCHER");
    expect(start).not.toContain("android.intent.category.LEANBACK_LAUNCHER");
  });

  it("uses enabled PackageManager candidates when multiple launchers resolve to Android's chooser", async () => {
    nativeRuntimeFixture();
    const normal = output;
    output = (args) => {
      if (args.includes("resolve-activity") && !args.includes("android.intent.category.HOME")) return "android/com.android.internal.app.ResolverActivity\n";
      if (args.includes("query-activities")) return "org.other/.Hijack\norg.example.app/.AFirst\norg.example.app/.Main$Inner\norg.example.app/.Main;reboot\n";
      return normal(args);
    };
    await runtime.launch({ ...app, tvActivity: "org.example.app.Main$Inner" }, "tv", settings, vi.fn());
    const start = processMocks.execFile.mock.calls.find((call) => call[1].includes("start"))![1];
    expect(start).toContain("'org.example.app/.Main$Inner'");
    expect(start).toContain("android.intent.category.LEANBACK_LAUNCHER");
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("query-activities"))).toBe(true);
  });

  it("does not bypass PackageManager with an unavailable manifest launcher", async () => {
    nativeRuntimeFixture();
    const normal = output;
    output = (args) => args.includes("resolve-activity") ? "No activity found\n" : normal(args);
    const error = await runtime.launch({ ...app, tvActivity: "org.example.app.DisabledActivity", launchableActivity: "org.example.app.DisabledActivity" }, "tv", settings, vi.fn()).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("未找到可用启动入口");
    expect((error as Error).message).toContain("org.example.app");
    expect((error as Error).message).toContain("Android 用户：0（RUNNING_UNLOCKED）");
    expect((error as Error).message).toContain("resolve: No activity found");
    expect((error as Error).message).toContain("query: No activities found");
    expect((error as Error).message).toContain("android.intent.category.LEANBACK_LAUNCHER");
    expect((error as Error).message).toContain("android.intent.category.LAUNCHER");
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("start"))).toBe(false);
  });

  it.each(["", "Starting: Intent { cmp=org.example.app/.Main }\n"])("does not announce launch success without an explicit am start status: %j", async (response) => {
    nativeRuntimeFixture();
    const normal = output;
    output = (args) => args.includes("start") ? response : normal(args);
    const progress = vi.fn();
    await expect(runtime.launch(app, "tv", settings, progress)).rejects.toThrow("启动应用失败");
    expect(progress.mock.calls.some(([message]) => message.includes("已在"))).toBe(false);
  });

  it("retries once after confirmed system HOME hides an apparently successful launch, then verifies stable foreground", async () => {
    nativeRuntimeFixture();
    const normal = output;
    let starts = 0;
    let foregroundChecks = 0;
    output = (args) => {
      if (args.includes("start")) { starts += 1; return "Status: ok\n"; }
      if (args.includes("dumpsys")) {
        foregroundChecks += 1;
        return foregroundDump(starts < 2 ? "com.android.launcher/.Home" : "org.example.app/.Main$Inner");
      }
      return normal(args);
    };
    vi.useFakeTimers();
    const opening = runtime.launch(app, "tv", settings, vi.fn());
    await vi.waitFor(() => expect(foregroundChecks).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(4000);
    await opening;
    expect(starts).toBe(2);
    const commands = processMocks.execFile.mock.calls.filter((call) => call[1].includes("start"));
    expect(commands[0][1]).toEqual(commands[1][1]);
  });

  it.each([
    { name: "persistent HOME", component: "com.android.launcher/.Home", user: 0, display: 0, locked: false, starts: 2, message: "未确认应用显示在前台" },
    { name: "permission prompt", component: "com.google.android.permissioncontroller/com.android.permissioncontroller.permission.ui.GrantPermissionsActivity", user: 0, display: 0, locked: false, starts: 1, message: "系统授权界面" },
    { name: "other app", component: "org.other/.Screen", user: 0, display: 0, locked: false, starts: 1, message: "未确认应用显示在前台" },
    { name: "different user", component: "org.example.app/.Main", user: 10, display: 0, locked: false, starts: 1, message: "未确认应用显示在前台" },
    { name: "secondary display", component: "org.example.app/.Main", user: 0, display: 1, locked: false, starts: 1, message: "未确认应用显示在前台" },
    { name: "locked screen", component: "com.android.launcher/.Home", user: 0, display: 0, locked: true, starts: 1, message: "完成解锁" },
  ])("does not claim foreground success or disturb $name", async ({ component, user, display, locked, starts, message }) => {
    const fixture = nativeRuntimeFixture();
    const normal = output;
    output = (args) => args.includes("dumpsys") ? foregroundDump(component, user, display, locked) : normal(args);
    const progress = vi.fn();
    vi.useFakeTimers();
    const opening = runtime.launch(app, "tv", settings, progress);
    const rejected = expect(opening).rejects.toThrow(message);
    await vi.waitFor(() => expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("dumpsys"))).toBe(true));
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    expect(processMocks.execFile.mock.calls.filter((call) => call[1].includes("start"))).toHaveLength(starts);
    expect(fixture.children[0].child.exitCode).toBeNull();
    expect(progress.mock.calls.some(([text]) => text.includes("已在模拟器原生窗口打开"))).toBe(false);
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("kill") || call[1].includes("force-stop"))).toBe(false);
  });

  it("does not retry or report success after disposal during foreground verification", async () => {
    const fixture = nativeRuntimeFixture();
    const normal = output;
    output = (args) => {
      if (args.includes("dumpsys")) { void runtime.dispose(); return foregroundDump("com.android.launcher/.Home"); }
      return normal(args);
    };
    const progress = vi.fn();
    await expect(runtime.launch(app, "tv", settings, progress)).rejects.toThrow("正在退出");
    await runtime.dispose();
    expect(processMocks.execFile.mock.calls.filter((call) => call[1].includes("start"))).toHaveLength(1);
    expect(fixture.children).toHaveLength(1);
    expect(progress.mock.calls.some(([text]) => text.includes("已在模拟器原生窗口打开"))).toBe(false);
  });

  it.each(["missing", "conflicting"])("does not accept a resumed app when primary keyguard state is %s", async (state) => {
    nativeRuntimeFixture();
    const normal = output;
    output = (args) => args.includes("dumpsys")
      ? state === "missing" ? foregroundDump("org.example.app/.Main").split("KeyguardController:")[0]
        : foregroundDump("org.example.app/.Main") + "  mKeyguardShowing=true\n"
      : normal(args);
    vi.useFakeTimers();
    const opening = runtime.launch(app, "tv", settings, vi.fn());
    const rejected = expect(opening).rejects.toThrow("未确认应用显示在前台");
    await vi.waitFor(() => expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("dumpsys"))).toBe(true));
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    expect(processMocks.execFile.mock.calls.filter((call) => call[1].includes("start"))).toHaveLength(1);
  });

  it("requires stable foreground instead of accepting one transient resumed activity", async () => {
    nativeRuntimeFixture();
    const normal = output;
    let checks = 0;
    output = (args) => args.includes("dumpsys") ? foregroundDump(++checks === 1 ? "org.example.app/.Main" : "com.google.android.permissioncontroller/.GrantPermissionsActivity") : normal(args);
    vi.useFakeTimers();
    const opening = runtime.launch(app, "tv", settings, vi.fn());
    const rejected = expect(opening).rejects.toThrow("系统授权界面");
    await vi.waitFor(() => expect(checks).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(12_000);
    await rejected;
    expect(checks).toBeGreaterThan(1);
    expect(processMocks.execFile.mock.calls.filter((call) => call[1].includes("start"))).toHaveLength(1);
  });

  it("does not open a window when an application has no launcher", async () => {
    const normal = output;
    output = (args) =>
      args.includes("resolve-activity") ? "No activity found" : normal(args);
    await expect(
      runtime.launch(app, "phone", settings, vi.fn()),
    ).rejects.toThrow("未找到可用启动入口");
    expect(processMocks.spawn).not.toHaveBeenCalled();
  });

  it("allows stale records to be cleared when an AVD has been wiped externally", async () => {
    const normal = output;
    output = (args) => (args.includes("packages") ? "" : normal(args));
    await runtime.uninstall(app, "phone", settings, vi.fn());
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("uninstall"),
      ),
    ).toBe(false);
  });

  it("requires uninstall success before clearing installation state", async () => {
    const normal = output;
    output = (args) =>
      args.includes("uninstall")
        ? "Failure [DELETE_FAILED_INTERNAL_ERROR]"
        : normal(args);
    await expect(
      runtime.uninstall(app, "phone", settings, vi.fn()),
    ).rejects.toThrow("DELETE_FAILED_INTERNAL_ERROR");
  });
  it("does not treat a directory named like a tool as an executable", async () => {
    const adbPath = join(settings.sdkPath, "platform-tools", exe("adb"));
    await rm(adbPath);
    await mkdir(adbPath);
    expect((await runtime.getStatus(settings)).adbFound).toBe(false);
  });

  it("boots a missing AVD headlessly and waits for its exact identity and boot state", async () => {
    const normal = output;
    let bootChecks = 0;
    output = (args) => {
      if (args[0] === "devices") return "List of devices attached\n";
      if (args.includes("emu")) return "Phone_API_35\nOK\n";
      if (args.includes("getprop")) {
        bootChecks += 1;
        return "1\n";
      }
      return normal(args);
    };
    expect(
      await runtime.install(app, apkPath, "phone", settings, vi.fn()),
    ).toEqual({ avd: "Phone_API_35" });
    const spawnArgs = processMocks.spawn.mock.calls[0][1];
    expect(spawnArgs).toEqual([
      "-avd",
      "Phone_API_35",
      "-port",
      expect.stringMatching(/^\d+$/),
      "-no-window",
      "-no-boot-anim",
    ]);
    expect(Number(spawnArgs[3]) % 2).toBe(0);
    expect(bootChecks).toBe(1);
    const installCall = processMocks.execFile.mock.calls.find((call) =>
      call[1].includes("install"),
    );
    expect(installCall?.[1][1]).toBe(`emulator-${spawnArgs[3]}`);
    await runtime.dispose();
    expect(processMocks.execFile).toHaveBeenCalledWith(
      expect.any(String),
      ["-s", `emulator-${spawnArgs[3]}`, "emu", "kill"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(scrcpy.kill).not.toHaveBeenCalled();
  });

  it("reports emulator process failures and never attempts installation", async () => {
    const normal = output;
    output = (args) =>
      args[0] === "devices"
        ? ""
        : args.includes("emu")
          ? "Phone_API_35\nOK\n"
          : normal(args);
    processMocks.spawn.mockImplementation(() => {
      queueMicrotask(() => scrcpy.emit("error", new Error("HVF unavailable")));
      return scrcpy;
    });
    await expect(
      runtime.install(app, apkPath, "phone", settings, vi.fn()),
    ).rejects.toThrow("HVF unavailable");
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("install"),
      ),
    ).toBe(false);
  });

  it("cancels an in-flight boot on disposal and kills only the owned emulator", async () => {
    const normal = output;
    output = (args) => {
      if (args[0] === "devices") return "";
      if (args.includes("emu")) return "Phone_API_35\nOK\n";
      if (args.includes("getprop")) {
        runtime.dispose();
        return "1\n";
      }
      return normal(args);
    };
    await expect(
      runtime.install(app, apkPath, "phone", settings, vi.fn()),
    ).rejects.toThrow("正在退出");
    await runtime.dispose();
    expect(
      processMocks.execFile.mock.calls.some((call) => call[1].includes("kill")),
    ).toBe(true);
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("install"),
      ),
    ).toBe(false);
  });

  it.each(["timeout", "error"])(
    "rejects am start Status: %s without opening a window",
    async (status) => {
      const normal = output;
      output = (args) =>
        args.includes("start")
          ? `Starting: Intent\nStatus: ${status}\n`
          : normal(args);
      await expect(
        runtime.launch(app, "phone", settings, vi.fn()),
      ).rejects.toThrow(`Status: ${status}`);
      expect(processMocks.spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects an immediate scrcpy process error", async () => {
    processMocks.spawn.mockImplementation(() => {
      queueMicrotask(() => scrcpy.emit("error", new Error("ENOEXEC")));
      return scrcpy;
    });
    await expect(
      runtime.launch(app, "phone", settings, vi.fn()),
    ).rejects.toThrow("ENOEXEC");
  });

  it("rejects an early scrcpy exit and includes its diagnostic output", async () => {
    processMocks.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        scrcpy.stderr?.emit("data", Buffer.from("Unsupported Android version"));
        scrcpy.emit("exit", 1);
      });
      return scrcpy;
    });
    await expect(
      runtime.launch(app, "phone", settings, vi.fn()),
    ).rejects.toThrow("Unsupported Android version");
  });

  it("replaces the previous window for one device and leaves external emulators running", async () => {
    const secondWindow = fakeChild();
    const windows = [scrcpy, secondWindow];
    processMocks.spawn.mockImplementation(() => {
      const child = windows.shift()!;
      queueMicrotask(() =>
        child.stdout?.emit("data", Buffer.from("INFO: Texture: 1080x1920\n")),
      );
      return child;
    });
    await runtime.launch(app, "phone", settings, vi.fn());
    await runtime.launch(app, "phone", settings, vi.fn());
    expect(scrcpy.kill).toHaveBeenCalledOnce();
    expect(secondWindow.kill).not.toHaveBeenCalled();
    expect(
      processMocks.spawn.mock.calls.every(
        (call) => call[0] === displayCommand(settings.scrcpyPath, []).file,
      ),
    ).toBe(true);
    runtime.dispose();
    expect(scrcpy.kill).toHaveBeenCalledOnce();
    expect(secondWindow.kill).toHaveBeenCalledOnce();
    expect(
      processMocks.execFile.mock.calls.some((call) => call[1].includes("kill")),
    ).toBe(false);
  });

  it("waits for a real video texture before reporting the display ready", async () => {
    processMocks.spawn.mockReturnValue(scrcpy);
    let resolved = false;
    const progress = vi.fn();
    const pending = runtime
      .launch(app, "phone", settings, progress)
      .then(() => {
        resolved = true;
      });
    await vi.waitFor(() => expect(processMocks.spawn).toHaveBeenCalled());
    scrcpy.stdout?.emit("data", Buffer.from("INFO: Renderer: opengl\n"));
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(progress).not.toHaveBeenCalledWith(
      expect.stringContaining("已在独立窗口打开"),
    );
    scrcpy.stdout?.emit(
      "data",
      Buffer.from("INFO: Initial texture: 1080x1920\n"),
    );
    await pending;
    expect(resolved).toBe(true);
  });

  it("fails and closes a display that never receives video", async () => {
    vi.useFakeTimers();
    processMocks.spawn.mockReturnValue(scrcpy);
    const pending = runtime.launch(app, "phone", settings, vi.fn());
    const rejected = expect(pending).rejects.toThrow("15 秒内未收到视频画面");
    await vi.waitFor(() => expect(processMocks.spawn).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(scrcpy.kill).toHaveBeenCalledOnce();
  });

  it("reports an abnormal exit after video is ready through the runtime error callback", async () => {
    const reportError = vi.fn();
    runtime = new AndroidRuntime(reportError);
    await runtime.launch(app, "phone", settings, vi.fn());
    scrcpy.stderr?.emit("data", Buffer.from("Device disconnected"));
    scrcpy.emit("exit", 1);
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("Device disconnected"),
    );
  });
  it("does not query or expose physical and wireless adb devices", async () => {
    const normal = output;
    output = (args) =>
      args[0] === "devices"
        ? "List of devices attached\nUSB123\tdevice\n192.168.1.20:5555\tdevice\nadb-device._adb-tls-connect._tcp\tdevice\nemulator-5554\tdevice\nemulator-5556\toffline\n"
        : normal(args);
    const status = await runtime.getStatus(settings);
    expect(status.devices).toEqual([
      { serial: "emulator-5554", state: "device", avd: "Phone_API_35" },
      { serial: "emulator-5556", state: "offline", avd: "" },
    ]);
    const addressedSerials = processMocks.execFile.mock.calls
      .filter((call) => call[1][0] === "-s")
      .map((call) => call[1][1]);
    expect(addressedSerials).toEqual(["emulator-5554"]);
  });

  it("discovers the private SDK from overrides instead of inherited Android paths", async () => {
    vi.stubEnv("ANDROID_SDK_ROOT", join(directory, "external-sdk"));
    vi.stubEnv("ANDROID_HOME", join(directory, "another-external-sdk"));
    const overrides = {
      ANDROID_SDK_ROOT: settings.sdkPath,
      ANDROID_HOME: settings.sdkPath,
      ANDROID_AVD_HOME: join(directory, "private-avds"),
      ADB_SERVER_SOCKET: "tcp:127.0.0.1:24567",
      ANDROID_ADB_SERVER_PORT: "24567",
    };
    runtime = new AndroidRuntime(undefined, overrides);
    const status = await runtime.getStatus({ ...settings, sdkPath: "" });
    expect(status.sdkFound).toBe(true);
    expect(status.adbFound).toBe(true);
    for (const call of processMocks.execFile.mock.calls) {
      expect(call[2].env).toEqual(expect.objectContaining(overrides));
      expect(call[0]).not.toContain("external-sdk");
    }
    expect(process.env.ANDROID_SDK_ROOT).toBe(join(directory, "external-sdk"));
  });

  it("hides unrelated emulators from managed runtime status", async () => {
    const normal = output;
    output = (args) => {
      if (args[0] === "devices")
        return `${normal(args)}emulator-5560\tdevice\n`;
      if (args[1] === "emulator-5560")
        return "External_AndroidStudio_Device\nOK\n";
      return normal(args);
    };
    runtime = new AndroidRuntime(undefined, {
      ANDROID_AVD_HOME: join(directory, "private-avds"),
    });
    const status = await runtime.getStatus(settings);
    expect(status.devices.map((device) => device.avd)).toEqual([
      "Phone_API_35",
      "TV_API_35",
    ]);
  });

  it("uses private AVD metadata even when inherited Android home has a conflicting image", async () => {
    const inheritedAvd = join(directory, "avds", "TV_API_35.avd");
    const privateAvd = join(directory, "private-avds", "TV_API_35.avd");
    await mkdir(inheritedAvd, { recursive: true });
    await mkdir(privateAvd, { recursive: true });
    await writeFile(
      join(inheritedAvd, "config.ini"),
      "tag.id=google_apis\nhw.device.name=pixel_8\n",
    );
    await writeFile(
      join(privateAvd, "config.ini"),
      "tag.id=android-tv\nhw.device.name=tv_1080p\n",
    );
    runtime = new AndroidRuntime(undefined, {
      ANDROID_AVD_HOME: join(directory, "private-avds"),
    });
    await expect(
      runtime.install(app, apkPath, "tv", settings, vi.fn()),
    ).resolves.toEqual({ avd: "TV_API_35" });
  });

  it("passes the same isolated environment to emulator boot and owned shutdown commands", async () => {
    const overrides = {
      ANDROID_AVD_HOME: join(directory, "private-avds"),
      ANDROID_USER_HOME: join(directory, "private-user"),
      ANDROID_EMULATOR_HOME: join(directory, "private-emulator"),
      ADB_SERVER_SOCKET: "tcp:127.0.0.1:24567",
      ANDROID_ADB_SERVER_PORT: "24567",
    };
    runtime = new AndroidRuntime(undefined, overrides);
    const normal = output;
    output = (args) =>
      args[0] === "devices"
        ? ""
        : args.includes("emu")
          ? "Phone_API_35\nOK\n"
          : normal(args);
    await runtime.install(app, apkPath, "phone", settings, vi.fn());
    expect(processMocks.spawn).toHaveBeenCalledWith(
      join(settings.sdkPath, "emulator", exe("emulator")),
      expect.arrayContaining(["-avd", "Phone_API_35"]),
      expect.objectContaining({ env: expect.objectContaining(overrides) }),
    );
    await runtime.dispose();
    expect(
      processMocks.execFile.mock.calls.some((call) => call[1].includes("kill")),
    ).toBe(true);
    for (const call of processMocks.execFile.mock.calls)
      expect(call[2].env).toEqual(expect.objectContaining(overrides));
    const emulatorStop = processMocks.execFile.mock.calls.findIndex((call) =>
      call[1].includes("kill"),
    );
    const serverStop = processMocks.execFile.mock.calls.findIndex((call) =>
      call[1].includes("kill-server"),
    );
    expect(serverStop).toBeGreaterThan(emulatorStop);
    expect(processMocks.execFile.mock.calls[serverStop][2].timeout).toBe(3000);
  });

  it("passes private SDK, adb socket and display server paths to scrcpy", async () => {
    const overrides = {
      ANDROID_HOME: settings.sdkPath,
      ANDROID_AVD_HOME: join(directory, "private-avds"),
      ADB_SERVER_SOCKET: "tcp:127.0.0.1:24567",
      ANDROID_ADB_SERVER_PORT: "24567",
      SCRCPY_SERVER_PATH: join(directory, "private-runtime", "scrcpy-server"),
    };
    runtime = new AndroidRuntime(undefined, overrides);
    await runtime.launch(app, "phone", settings, vi.fn());
    expect(processMocks.spawn).toHaveBeenCalledWith(
      displayCommand(settings.scrcpyPath, []).file,
      expect.arrayContaining(["--serial", "emulator-5554"]),
      expect.objectContaining({
        env: expect.objectContaining({
          ...overrides,
          ADB: join(settings.sdkPath, "platform-tools", exe("adb")),
        }),
      }),
    );
  });

  it("does not make APK import depend on external aapt tools", async () => {
    await rm(join(settings.sdkPath, "build-tools"), { recursive: true });
    const status = await runtime.getStatus(settings);
    expect(status.aaptFound).toBe(false);
    expect(status.issues).toEqual([]);
  });

  it.each(["tcp:127.0.0.1:24567", "tcp:localhost:24567"])(
    "shuts down only the private adb socket used by this instance: %s",
    async (socket) => {
      const overrides = {
        ADB_SERVER_SOCKET: socket,
        ANDROID_ADB_SERVER_PORT: "24567",
      };
      runtime = new AndroidRuntime(undefined, overrides);
      await runtime.getStatus(settings);
      await runtime.dispose();
      await runtime.dispose();
      const shutdowns = processMocks.execFile.mock.calls.filter(
        (call) => call[1][0] === "kill-server",
      );
      expect(shutdowns).toHaveLength(1);
      expect(shutdowns[0]).toEqual([
        join(settings.sdkPath, "platform-tools", exe("adb")),
        ["kill-server"],
        expect.objectContaining({
          timeout: 3000,
          env: expect.objectContaining(overrides),
        }),
        expect.any(Function),
      ]);
    },
  );

  it("does not stop a private socket when no adb command was invoked", async () => {
    runtime = new AndroidRuntime(undefined, {
      ADB_SERVER_SOCKET: "tcp:127.0.0.1:24567",
    });
    await runtime.getAaptPath(settings);
    await runtime.dispose();
    expect(processMocks.execFile).not.toHaveBeenCalled();
  });

  it("does not claim ownership of an inherited adb server socket", async () => {
    vi.stubEnv("ADB_SERVER_SOCKET", "tcp:127.0.0.1:24567");
    runtime = new AndroidRuntime();
    await runtime.getStatus(settings);
    await runtime.dispose();
    expect(
      processMocks.execFile.mock.calls.some(
        (call) => call[1][0] === "kill-server",
      ),
    ).toBe(false);
  });

  it.each([
    "tcp:127.0.0.1:5037",
    "tcp:localhost:5037",
    "tcp:remotehost:24567",
    "tcp:127.0.0.1:0",
  ])("never shuts down default or nonprivate adb socket %s", async (socket) => {
    runtime = new AndroidRuntime(undefined, { ADB_SERVER_SOCKET: socket });
    await runtime.getStatus(settings);
    await runtime.dispose();
    expect(
      processMocks.execFile.mock.calls.some(
        (call) => call[1][0] === "kill-server",
      ),
    ).toBe(false);
  });

  it("does not restart an adb daemon after disposal", async () => {
    runtime = new AndroidRuntime(undefined, {
      ADB_SERVER_SOCKET: "tcp:127.0.0.1:24567",
    });
    await runtime.dispose();
    await runtime.getStatus(settings);
    expect(processMocks.execFile).not.toHaveBeenCalled();
  });
  async function installIntoOwnedEmulator(): Promise<void> {
    const normal = output;
    output = (args) =>
      args[0] === "devices"
        ? ""
        : args.includes("emu")
          ? "Phone_API_35\nOK\n"
          : normal(args);
    await runtime.install(app, apkPath, "phone", settings, vi.fn());
  }

  it("waits for QEMU exit after console acknowledgement before shutting down private adb", async () => {
    runtime = new AndroidRuntime(undefined, {
      ADB_SERVER_SOCKET: "tcp:localhost:24567",
    });
    await installIntoOwnedEmulator();
    autoExitAfterEmulatorKill = false;
    let finished = false;
    const stopping = runtime.dispose().then(() => {
      finished = true;
    });
    await vi.waitFor(() =>
      expect(
        processMocks.execFile.mock.calls.some((call) =>
          call[1].includes("kill"),
        ),
      ).toBe(true),
    );
    expect(finished).toBe(false);
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("kill-server"),
      ),
    ).toBe(false);
    expect(scrcpy.kill).not.toHaveBeenCalled();
    scrcpy.emit("exit", 0, null);
    await stopping;
    expect(finished).toBe(true);
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("kill-server"),
      ),
    ).toBe(true);
    expect(scrcpy.kill).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux"])(
    "bounds graceful shutdown and waits for SIGTERM on %s",
    async (platform) => {
      await installIntoOwnedEmulator();
      // Tool fixtures use the native host's executable names; only the shutdown
      // branch is mocked, after the owned process has already been created.
      Object.defineProperty(process, "platform", { value: platform });
      autoExitAfterEmulatorKill = false;
      vi.useFakeTimers();
      const stopping = runtime.dispose();
      await vi.advanceTimersByTimeAsync(14_999);
      expect(scrcpy.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(scrcpy.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
      expect(
        processMocks.execFile.mock.calls.some((call) => call[0] === "taskkill"),
      ).toBe(false);
    },
  );

  it.each(["darwin", "linux"])(
    "escalates to SIGKILL only when the owned emulator ignores SIGTERM on %s",
    async (platform) => {
      await installIntoOwnedEmulator();
      Object.defineProperty(process, "platform", { value: platform });
      autoExitAfterEmulatorKill = false;
      vi.mocked(scrcpy.kill).mockImplementation((signal) => {
        if (signal === "SIGKILL")
          queueMicrotask(() => scrcpy.emit("exit", null, signal));
        return true;
      });
      vi.useFakeTimers();
      const stopping = runtime.dispose();
      await vi.advanceTimersByTimeAsync(18_000);
      await stopping;
      expect(scrcpy.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(scrcpy.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(
        processMocks.execFile.mock.calls.some((call) => call[0] === "taskkill"),
      ).toBe(false);
    },
  );

  it("uses taskkill on the owned Windows process tree instead of killing only its launcher", async () => {
    await installIntoOwnedEmulator();
    autoExitAfterEmulatorKill = false;
    Object.defineProperty(process, "platform", { value: "win32" });
    const normalExec = processMocks.execFile.getMockImplementation()!;
    processMocks.execFile.mockImplementation(
      (file, args, options, callback) => {
        if (file === "taskkill") {
          callback(null, "SUCCESS", "");
          queueMicrotask(() => scrcpy.emit("exit", 1, null));
        } else normalExec(file, args, options, callback);
      },
    );
    vi.useFakeTimers();
    const stopping = runtime.dispose();
    await vi.advanceTimersByTimeAsync(15_000);
    await stopping;
    expect(processMocks.execFile).toHaveBeenCalledWith(
      "taskkill",
      ["/PID", "12345", "/T", "/F"],
      expect.objectContaining({ timeout: 3000 }),
      expect.any(Function),
    );
    expect(scrcpy.kill).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux", "win32"])(
    "rejects unconfirmed process exit and cleans private adb on %s",
    async (platform) => {
      runtime = new AndroidRuntime(undefined, {
        ADB_SERVER_SOCKET: "tcp:localhost:24567",
      });
      await installIntoOwnedEmulator();
      Object.defineProperty(process, "platform", { value: platform });
      autoExitAfterEmulatorKill = false;
      vi.mocked(scrcpy.kill).mockReturnValue(true);
      vi.useFakeTimers();
      const stopping = runtime.dispose();
      const rejected = expect(stopping).rejects.toThrow("无法确认模拟器");
      await vi.advanceTimersByTimeAsync(21_000);
      await rejected;
      if (platform === "win32") {
        expect(processMocks.execFile).toHaveBeenCalledWith(
          "taskkill",
          ["/PID", "12345", "/T", "/F"],
          expect.any(Object),
          expect.any(Function),
        );
        expect(scrcpy.kill).not.toHaveBeenCalled();
      } else {
        expect(scrcpy.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
        expect(scrcpy.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      }
      expect(
        processMocks.execFile.mock.calls.some((call) =>
          call[1].includes("kill-server"),
        ),
      ).toBe(true);
    },
  );

  it("reports unexpected owned emulator exits with signal, exit code and last stderr", async () => {
    const reportError = vi.fn();
    runtime = new AndroidRuntime(reportError);
    await installIntoOwnedEmulator();
    scrcpy.stderr?.emit("data", Buffer.from("QEMU fatal diagnostic"));
    scrcpy.emit("exit", 137, "SIGKILL");
    expect(reportError).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledWith(
      expect.stringContaining("Phone_API_35"),
    );
    expect(reportError.mock.calls[0][0]).toContain("137");
    expect(reportError.mock.calls[0][0]).toContain("SIGKILL");
    expect(reportError.mock.calls[0][0]).toContain("QEMU fatal diagnostic");
  });

  it("does not report normal emulator exit or an intentional shutdown as a crash", async () => {
    const reportError = vi.fn();
    runtime = new AndroidRuntime(reportError);
    await installIntoOwnedEmulator();
    await runtime.dispose();
    expect(reportError).not.toHaveBeenCalled();
    runtime = new AndroidRuntime(reportError);
    scrcpy = fakeChild();
    await installIntoOwnedEmulator();
    scrcpy.emit("exit", 0, null);
    expect(reportError).not.toHaveBeenCalled();
  });

  it("retains the adb install error from stdout together with stderr and exit diagnostics", async () => {
    processMocks.execFile.mockImplementation(
      (_file, args, _options, callback) => {
        if (args.includes("install")) {
          const error = Object.assign(new Error("install command failed"), {
            code: 1,
            signal: "SIGTERM",
            killed: true,
          });
          callback(
            error,
            "Failure [INSTALL_FAILED_TEST_DIAGNOSTIC]",
            `${"verbose\n".repeat(1000)}adb: failed to install /tmp/app.apk:`,
          );
        } else callback(null, output(args), "");
      },
    );
    let error: Error | undefined;
    try {
      await runtime.install(app, apkPath, "tv", settings, vi.fn());
    } catch (caught) {
      error = caught as Error;
    }
    expect(error?.message).toContain("INSTALL_FAILED_TEST_DIAGNOSTIC");
    expect(error?.message).toContain("adb: failed to install /tmp/app.apk:");
    expect(error?.message).toContain("退出代码：1");
    expect(error?.message).toContain("SIGTERM");
    expect(error?.message).toContain("被终止或执行超时");
    expect(error!.message.length).toBeLessThan(8000);
  });

  it("keeps process launch errors when neither stdout nor stderr is available", async () => {
    processMocks.execFile.mockImplementation(
      (_file, _args, _options, callback) => {
        callback(
          Object.assign(new Error("spawn adb ENOENT"), { code: "ENOENT" }),
          "",
          "",
        );
      },
    );
    const status = await runtime.getStatus(settings);
    expect(status.issues.join("\n")).toContain("spawn adb ENOENT");
    expect(status.issues.join("\n")).toContain("退出代码：ENOENT");
  });
  function nativeRuntimeFixture(reportError = vi.fn(), autoClose = true) {
    const environment = {
      APK_CHECKER_DISPLAY_MODE: "native",
      ANDROID_AVD_HOME: join(directory, "private-avds"),
      ADB_SERVER_SOCKET: "tcp:localhost:24567",
      ANDROID_ADB_SERVER_PORT: "24567",
    };
    runtime = new AndroidRuntime(reportError, environment);
    const children: {
      child: ChildProcess;
      avd: string;
      serial: string;
      native: boolean;
      grpcPort: number;
      avdDirectory: string;
      discoveryPath: string;
    }[] = [];
    const live = new Map<string, (typeof children)[number]>();
    const events: string[] = [];
    const normal = output;
    output = (args) => {
      if (args[0] === "devices")
        return [...live.keys()].map((serial) => `${serial}\tdevice`).join("\n");
      if (args.includes("emu")) {
        const target = live.get(args[1]);
        if (args.includes("discoverypath"))
          return `${target?.discoveryPath || "NO_AVD_INFO"}\nOK\n`;
        if (args.includes("windowtype"))
          return `windowtype=${target?.native ? "qtwindow" : "headless"}\nOK\n`;
        if (args.includes("name"))
          return `${target?.avd || "not-running"}\nOK\n`;
        if (args.includes("kill")) return "OK: killing emulator, bye bye\nOK\n";
      }
      return normal(args);
    };
    processMocks.spawn.mockImplementation((_file, args) => {
      const target = {
        child: fakeChild(autoClose),
        avd: args[args.indexOf("-avd") + 1],
        serial: `emulator-${args[args.indexOf("-port") + 1]}`,
        native: !args.includes("-no-window"),
        grpcPort: Number(args[args.indexOf("-grpc") + 1]),
        avdDirectory: join(
          environment.ANDROID_AVD_HOME,
          `${args[args.indexOf("-avd") + 1]}.avd`,
        ),
        discoveryPath: join(
          directory,
          "discovery",
          args[args.indexOf("-avd") + 1],
          "pid_12345.ini",
        ),
      };
      children.push(target);
      live.set(target.serial, target);
      events.push(target.native ? "native-spawn" : "headless-spawn");
      target.child.on("exit", () => {
        if (live.get(target.serial) === target) live.delete(target.serial);
        events.push(target.native ? "native-exit" : "headless-exit");
      });
      return target.child;
    });
    processMocks.execFile.mockImplementation(
      (_file, args, _options, callback) => {
        const target = live.get(args[1]);
        const response = output(args);
        callback(null, response, "");
        if (args.includes("emu") && args.includes("kill")) {
          queueMicrotask(() => target?.child.emit("exit", 0, null));
        }
      },
    );
    return { children, events, environment, reportError };
  }

  const snapshotFailure = "qemu-system-aarch64: error while loading state for instance 0x0 of device 'goldfish_pipe'";

  it.each(["stdout", "stderr"] as const)(
    "cold boots once after the TV snapshot failure on %s, even when QEMU exits with code 0",
    async (stream) => {
      const fixture = nativeRuntimeFixture();
      const spawnDevice = processMocks.spawn.getMockImplementation()!;
      processMocks.spawn.mockImplementation((file, args, options) => {
        const child = spawnDevice(file, args, options) as ChildProcess;
        if (fixture.children.length === 1) queueMicrotask(() => {
          child[stream]?.emit("data", snapshotFailure.slice(0, 42));
          child[stream]?.emit("data", snapshotFailure.slice(42) + "\n");
          child[stream]?.emit("data", "IMKCFRunLoopWakeUpReliable\n".repeat(500));
          child.emit("exit", 0, null);
        });
        return child;
      });
      const progress = vi.fn();
      await expect(runtime.install(app, apkPath, "tv", settings, progress)).resolves.toEqual({ avd: settings.tvAvd });
      expect(fixture.children).toHaveLength(2);
      expect(fixture.events).toEqual(["headless-spawn", "headless-exit", "headless-spawn"]);
      expect(processMocks.spawn.mock.calls[0][1]).not.toContain("-no-snapshot-load");
      expect(processMocks.spawn.mock.calls[1][1]).toContain("-no-snapshot-load");
      for (const [, args, options] of processMocks.spawn.mock.calls) {
        expect(args).toContain(settings.tvAvd);
        expect(args).not.toContain("-wipe-data");
        expect(options).toMatchObject({ env: expect.objectContaining(fixture.environment), stdio: ["ignore", "pipe", "pipe"] });
      }
      expect(progress).toHaveBeenCalledWith(expect.stringContaining("快照恢复失败"));
      expect(fixture.reportError).not.toHaveBeenCalled();
      expect(processMocks.execFile.mock.calls.filter((call) => call[1].includes("install"))).toHaveLength(1);
    },
  );

  it("drains snapshot diagnostics arriving after the process exit event before deciding recovery", async () => {
    const fixture = nativeRuntimeFixture(vi.fn(), false);
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      if (fixture.children.length === 1) queueMicrotask(() => {
        child.emit("exit", 0, null);
        // Let the startup poll observe exit before the final pipe data arrives.
        setImmediate(() => {
          child.stdout?.emit("data", snapshotFailure + "\n");
          child.emit("close", 0, null);
        });
      });
      return child;
    });
    await runtime.install(app, apkPath, "tv", settings, vi.fn());
    expect(fixture.children).toHaveLength(2);
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it("stops after two attempts when cold boot also reports a snapshot restore failure", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      queueMicrotask(() => { child.stderr?.emit("data", snapshotFailure); child.emit("exit", 0, null); });
      return child;
    });
    await expect(runtime.install(app, apkPath, "tv", settings, vi.fn())).rejects.toThrow("冷启动失败");
    expect(fixture.children).toHaveLength(2);
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("install"))).toBe(false);
  });

  it("retains the snapshot cause if selecting a port for cold boot fails", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      queueMicrotask(() => { child.stderr?.emit("data", snapshotFailure); child.emit("exit", 0, null); });
      return child;
    });
    const port = vi.spyOn(runtime as unknown as { freePort(): Promise<number> }, "freePort")
      .mockResolvedValueOnce(5554).mockRejectedValueOnce(new Error("Port selection failed"));
    try {
      const error = await runtime.install(app, apkPath, "tv", settings, vi.fn()).catch((failure: Error) => failure);
      expect((error as Error).message).toContain(snapshotFailure);
      expect((error as Error).message).toContain("Port selection failed");
      expect(fixture.children).toHaveLength(1);
    } finally {
      port.mockRestore();
    }
  });

  it("stops a live process with a fatal snapshot restore error before cold booting", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      if (fixture.children.length === 1) queueMicrotask(() => child.stderr?.emit("data", snapshotFailure));
      return child;
    });
    await runtime.install(app, apkPath, "tv", settings, vi.fn());
    expect(fixture.events).toEqual(["headless-spawn", "headless-exit", "headless-spawn"]);
    expect(processMocks.execFile.mock.calls.filter((call) => call[1].includes("kill"))).toHaveLength(1);
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it("keeps the first snapshot cause and both attempts' bounded diagnostics when cold boot fails", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      const first = fixture.children.length === 1;
      queueMicrotask(() => {
        if (first) {
          // The fatal prefix is recognizable before its device name arrives.
          child.stderr?.emit("data", snapshotFailure.slice(0, 76));
          child.stderr?.emit("data", snapshotFailure.slice(76) + "\n");
        } else child.stderr?.emit("data", "Second attempt: HVF unavailable\n");
        child.stdout?.emit("data", (first ? "First stdout\n" : "Second stdout\n").repeat(500));
        if (first) child.stderr?.emit("data", "IMKCFRunLoopWakeUpReliable\n".repeat(500));
        child.emit("exit", first ? 0 : 1, null);
      });
      return child;
    });
    const error = await runtime.install(app, apkPath, "tv", settings, vi.fn()).catch((failure: Error) => failure);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(snapshotFailure);
    expect(message).toContain("退出代码：0");
    expect(message).toContain("冷启动失败");
    expect(message).toContain("Second attempt: HVF unavailable");
    expect(message).toContain("First stdout");
    expect(message).toContain("Second stdout");
    expect(message.length).toBeLessThan(17_000);
    expect(fixture.children).toHaveLength(2);
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("install"))).toBe(false);
  });

  it.each([false, true])("does not retry ordinary IMK/h264 output (process exits: %s)", async (exits) => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      queueMicrotask(() => {
        child.stdout?.emit("data", "[h264] no frame!\n");
        child.stderr?.emit("data", "IMKCFRunLoopWakeUpReliable\nTSM keyboard\n");
        if (exits) child.emit("exit", 0, null);
      });
      return child;
    });
    const installing = runtime.install(app, apkPath, "tv", settings, vi.fn());
    if (exits) await expect(installing).rejects.toThrow("退出代码：0");
    else await expect(installing).resolves.toEqual({ avd: settings.tvAvd });
    expect(fixture.children).toHaveLength(1);
  });

  it("retains ownership and refuses recovery when the failed snapshot process cannot be stopped", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      vi.mocked(child.kill).mockReturnValue(false);
      queueMicrotask(() => child.stderr?.emit("data", snapshotFailure));
      return child;
    });
    const exec = processMocks.execFile.getMockImplementation()!;
    processMocks.execFile.mockImplementation((file, args, options, callback) => {
      if (args.includes("emu") && args.includes("kill")) callback(new Error("console unavailable"), "", "");
      else exec(file, args, options, callback);
    });
    vi.useFakeTimers();
    const installing = runtime.install(app, apkPath, "tv", settings, vi.fn());
    const rejected = expect(installing).rejects.toThrow("无法确认模拟器");
    await vi.waitFor(() => expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("kill"))).toBe(true));
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(fixture.children).toHaveLength(1);
    // A later cleanup still owns the original process and can stop it.
    processMocks.execFile.mockImplementation(exec);
    await runtime.dispose();
    expect(fixture.children[0].child.exitCode).toBe(0);
  });

  it("does not retry when quitting while the snapshot process is stopping", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      queueMicrotask(() => child.stderr?.emit("data", snapshotFailure));
      return child;
    });
    const exec = processMocks.execFile.getMockImplementation()!;
    processMocks.execFile.mockImplementation((file, args, options, callback) => {
      if (args.includes("emu") && args.includes("kill")) callback(null, "OK\n", "");
      else exec(file, args, options, callback);
    });
    const installing = runtime.install(app, apkPath, "tv", settings, vi.fn());
    const cancelled = expect(installing).rejects.toThrow("正在退出");
    await vi.waitFor(() => expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("kill"))).toBe(true));
    const stopping = runtime.dispose();
    fixture.children[0].child.emit("exit", 0, null);
    await cancelled;
    await stopping;
    expect(fixture.children).toHaveLength(1);
  });

  it("does not restart if the cold boot progress callback requests disposal", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      queueMicrotask(() => { child.stderr?.emit("data", snapshotFailure); child.emit("exit", 0, null); });
      return child;
    });
    await expect(runtime.install(app, apkPath, "tv", settings, (message) => {
      if (message.startsWith("快照恢复失败")) void runtime.dispose();
    })).rejects.toThrow("正在退出");
    expect(fixture.children).toHaveLength(1);
  });

  it("keeps external devices alive when waiting for their boot times out", async () => {
    const normal = output;
    output = (args) => args.includes("getprop") ? "0\n" : normal(args);
    vi.useFakeTimers();
    const installing = runtime.install(app, apkPath, "tv", settings, vi.fn());
    const rejected = expect(installing).rejects.toThrow("已连接目标模拟器，等待 Android 完成启动");
    await vi.waitFor(() => expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("getprop"))).toBe(true));
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("kill"))).toBe(false);
  });

  it("includes the last boot phase, adb error and both output streams in a startup timeout", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnDevice = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnDevice(file, args, options) as ChildProcess;
      queueMicrotask(() => {
        child.stdout?.emit("data", "Guest still booting\n");
        child.stderr?.emit("data", "Graphics warning\n");
      });
      return child;
    });
    const exec = processMocks.execFile.getMockImplementation()!;
    processMocks.execFile.mockImplementation((file, args, options, callback) => {
      if (args.includes("getprop")) callback(new Error("device offline"), "", "device offline");
      else exec(file, args, options, callback);
    });
    vi.useFakeTimers();
    const installing = runtime.install(app, apkPath, "tv", settings, vi.fn()).catch((error: Error) => error);
    await vi.waitFor(() => expect(processMocks.execFile.mock.calls.some((call) => call[1].includes("getprop"))).toBe(true));
    await vi.advanceTimersByTimeAsync(180_000);
    const result = await installing;
    expect(result).toBeInstanceOf(Error);
    const message = (result as Error).message;
    expect(message).toContain("已连接目标模拟器，等待 Android 完成启动");
    expect(message).toContain("device offline");
    expect(message).toContain("Guest still booting");
    expect(message).toContain("Graphics warning");
    expect(fixture.children).toHaveLength(1);
    expect(fixture.children[0].child.exitCode).toBe(0);
  });

  it("switches its installed headless device to a native Qt window only after the old process exits", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.install(app, apkPath, "phone", settings, vi.fn());
    await rm(settings.scrcpyPath);
    const progress = vi.fn();
    await runtime.launch(app, "phone", settings, progress);
    expect(fixture.events).toEqual([
      "headless-spawn",
      "headless-exit",
      "native-spawn",
    ]);
    expect(fixture.children.map((child) => child.avd)).toEqual([
      settings.phoneAvd,
      settings.phoneAvd,
    ]);
    expect(
      processMocks.spawn.mock.calls.every(
        (call) =>
          call[0] === join(settings.sdkPath, "emulator", exe("emulator")),
      ),
    ).toBe(true);
    expect(processMocks.spawn.mock.calls[0][1]).toContain("-no-window");
    expect(processMocks.spawn.mock.calls[1][1]).not.toContain("-no-window");
    expect(processMocks.spawn.mock.calls[1][1]).not.toContain(
      "-qt-hide-window",
    );
    expect(processMocks.spawn.mock.calls[1][1]).not.toContain("-wipe-data");
    expect(processMocks.spawn.mock.calls[1][1]).toContain("-no-snapshot-load");
    expect(processMocks.spawn.mock.calls[1][2]).toMatchObject({
      windowsHide: false,
      env: expect.objectContaining(fixture.environment),
    });
    expect(
      processMocks.execFile.mock.calls.filter((call) =>
        call[1].includes("install"),
      ),
    ).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith("示例应用 已在模拟器原生窗口打开。");
    expect(fixture.reportError).not.toHaveBeenCalled();
    const status = await runtime.getStatus(settings);
    expect(status.scrcpyFound).toBe(false);
    expect(status.issues).toEqual([]);
  });

  it("reuses an owned native device, wakes it again and restarts natively after its window closes", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    await runtime.launch(app, "phone", settings, vi.fn());
    expect(fixture.children).toHaveLength(1);
    expect(fixture.children[0].native).toBe(true);
    expect(
      processMocks.execFile.mock.calls.filter((call) =>
        call[1].includes("KEYCODE_WAKEUP"),
      ),
    ).toHaveLength(2);
    expect(
      processMocks.execFile.mock.calls.filter((call) =>
        call[1].includes("kill"),
      ),
    ).toHaveLength(0);
    fixture.children[0].child.emit("exit", 0, null);
    await runtime.launch(app, "phone", settings, vi.fn());
    expect(fixture.children).toHaveLength(2);
    expect(fixture.children[1].native).toBe(true);
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it("opens native TV with its leanback launcher and never starts scrcpy", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "tv", settings, vi.fn());
    expect(fixture.children[0]).toMatchObject({
      avd: settings.tvAvd,
      native: true,
    });
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("android.intent.category.LEANBACK_LAUNCHER"),
      ),
    ).toBe(true);
    expect(
      processMocks.spawn.mock.calls.some(
        (call) => call[0] === settings.scrcpyPath,
      ),
    ).toBe(false);
  });

  it("never stops an externally owned headless device to convert its display", async () => {
    runtime = new AndroidRuntime(undefined, {
      APK_CHECKER_DISPLAY_MODE: "native",
    });
    const normal = output;
    output = (args) =>
      args.includes("windowtype") ? "windowtype=headless\nOK\n" : normal(args);
    await expect(
      runtime.launch(app, "phone", settings, vi.fn()),
    ).rejects.toThrow("当前模拟器没有可显示的窗口");
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(
      processMocks.execFile.mock.calls.some((call) => call[1].includes("kill")),
    ).toBe(false);
  });

  it("can reuse an external Qt device without claiming ownership or stopping it", async () => {
    runtime = new AndroidRuntime(undefined, {
      APK_CHECKER_DISPLAY_MODE: "native",
    });
    const normal = output;
    output = (args) =>
      args.includes("windowtype") ? "windowtype=qtwindow\nOK\n" : normal(args);
    await runtime.launch(app, "phone", settings, vi.fn());
    await runtime.dispose();
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(
      processMocks.execFile.mock.calls.some((call) => call[1].includes("kill")),
    ).toBe(false);
  });

  it("rejects unknown native window status before launching the APK", async () => {
    nativeRuntimeFixture();
    const normal = output;
    output = (args) =>
      args.includes("windowtype") ? "KO: unknown command\n" : normal(args);
    await expect(
      runtime.launch(app, "phone", settings, vi.fn()),
    ).rejects.toThrow("原生窗口未就绪");
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("start"),
      ),
    ).toBe(false);
  });

  it("does not boot a second device if the old headless process cannot be stopped", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.install(app, apkPath, "phone", settings, vi.fn());
    const old = fixture.children[0].child;
    vi.mocked(old.kill).mockReturnValue(false);
    const normal = processMocks.execFile.getMockImplementation()!;
    processMocks.execFile.mockImplementation(
      (file, args, options, callback) => {
        if (args.includes("emu") && args.includes("kill"))
          callback(new Error("console unavailable"), "", "");
        else normal(file, args, options, callback);
      },
    );
    vi.useFakeTimers();
    const opening = runtime.launch(app, "phone", settings, vi.fn());
    const rejected = expect(opening).rejects.toThrow("无法确认模拟器");
    await vi.waitFor(() =>
      expect(
        processMocks.execFile.mock.calls.some((call) =>
          call[1].includes("kill"),
        ),
      ).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(6000);
    await rejected;
    expect(fixture.children).toHaveLength(1);
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("start"),
      ),
    ).toBe(false);
    // The failed transition retained ownership; cleanup can still stop this process.
    old.emit("exit", 0, null);
  });

  it("reports a native window process failure without reporting APK launch success", async () => {
    const fixture = nativeRuntimeFixture();
    const spawnNative = processMocks.spawn.getMockImplementation()!;
    processMocks.spawn.mockImplementation((file, args, options) => {
      const child = spawnNative(file, args, options) as ChildProcess;
      queueMicrotask(() => {
        child.stderr?.emit(
          "data",
          Buffer.from("Qt platform initialization failed"),
        );
        child.emit("exit", 1, null);
      });
      return child;
    });
    const progress = vi.fn();
    await expect(
      runtime.launch(app, "phone", settings, progress),
    ).rejects.toThrow("启动失败");
    expect(progress).not.toHaveBeenCalledWith(
      "示例应用 已在模拟器原生窗口打开。",
    );
    expect(fixture.reportError).not.toHaveBeenCalled();
  });

  it("waits for an in-progress headless transition on quit and does not start its native replacement", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.install(app, apkPath, "phone", settings, vi.fn());
    const normal = processMocks.execFile.getMockImplementation()!;
    processMocks.execFile.mockImplementation(
      (file, args, options, callback) => {
        if (args.includes("emu") && args.includes("kill"))
          callback(null, "OK\n", "");
        else normal(file, args, options, callback);
      },
    );
    const opening = runtime.launch(app, "phone", settings, vi.fn());
    const cancelled = expect(opening).rejects.toThrow("正在退出");
    await vi.waitFor(() =>
      expect(
        processMocks.execFile.mock.calls.some((call) =>
          call[1].includes("kill"),
        ),
      ).toBe(true),
    );
    let stopped = false;
    const stopping = runtime.dispose().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("kill-server"),
      ),
    ).toBe(false);
    fixture.children[0].child.emit("exit", 0, null);
    await cancelled;
    await stopping;
    expect(fixture.children).toHaveLength(1);
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("kill-server"),
      ),
    ).toBe(true);
  });
  it("does not spawn a native emulator after quitting during port selection", async () => {
    const fixture = nativeRuntimeFixture();
    let releasePort!: (port: number) => void;
    const selectingPort = vi
      .spyOn(runtime as unknown as { freePort(): Promise<number> }, "freePort")
      .mockImplementation(
        () =>
          new Promise<number>((resolvePort) => {
            releasePort = resolvePort;
          }),
      );
    const opening = runtime.launch(app, "phone", settings, vi.fn());
    const cancelled = expect(opening).rejects.toThrow("正在退出");
    await vi.waitFor(() => expect(selectingPort).toHaveBeenCalledOnce());
    await runtime.dispose();
    releasePort(5554);
    await cancelled;
    selectingPort.mockRestore();
    expect(fixture.children).toHaveLength(0);
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("start"),
      ),
    ).toBe(false);
  });

  it("does not spawn a native emulator if a startup progress callback requests exit", async () => {
    const fixture = nativeRuntimeFixture();
    const progress = vi.fn((message: string) => {
      if (message.startsWith("正在启动")) void runtime.dispose();
    });
    await expect(
      runtime.launch(app, "phone", settings, progress),
    ).rejects.toThrow("正在退出");
    await runtime.dispose();
    expect(progress).toHaveBeenCalledWith(expect.stringContaining("正在启动"));
    expect(fixture.children).toHaveLength(0);
    expect(processMocks.spawn).not.toHaveBeenCalled();
  });
  async function writeClipboardAdvertisement(
    target: ReturnType<typeof nativeRuntimeFixture>["children"][number],
    changes: Record<string, string> = {},
  ) {
    await mkdir(target.avdDirectory, { recursive: true });
    await mkdir(dirname(target.discoveryPath), { recursive: true });
    const values = {
      "avd.id": target.avd,
      "avd.dir": target.avdDirectory,
      "port.serial": target.serial.replace("emulator-", ""),
      "grpc.port": String(target.grpcPort),
      "grpc.token": Buffer.from(`secret for ${target.avd}`).toString("base64"),
      ...changes,
    };
    await writeFile(
      target.discoveryPath,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n"),
    );
    return values;
  }

  it("enables authenticated per-device gRPC only on native emulator startup", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.install(app, apkPath, "phone", settings, vi.fn());
    expect(processMocks.spawn.mock.calls[0][1]).not.toContain("-grpc");
    await runtime.launch(app, "phone", settings, vi.fn());
    const nativeArgs = processMocks.spawn.mock.calls[1][1] as string[];
    expect(nativeArgs).toContain("-grpc-use-token");
    expect(Number(nativeArgs[nativeArgs.indexOf("-grpc") + 1])).toBeGreaterThan(
      1023,
    );
    expect(fixture.children[1].grpcPort).toBe(
      Number(nativeArgs[nativeArgs.indexOf("-grpc") + 1]),
    );
  });

  it("sends exact Unicode through verified gRPC then pastes once without Enter", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    const target = fixture.children[0];
    const advertisement = await writeClipboardAdvertisement(target);
    const text = "你好 😀 'quoted' \"双引号\"\nnext line";
    clipboardMock.mockImplementation(async (_port, _token, value) => {
      expect(value).toBe(text);
      expect(
        processMocks.execFile.mock.calls.some((call) =>
          call[1].includes("KEYCODE_PASTE"),
        ),
      ).toBe(false);
    });
    await runtime.sendText("phone", text, settings);
    expect(clipboardMock).toHaveBeenCalledExactlyOnceWith(
      target.grpcPort,
      advertisement["grpc.token"],
      text,
      expect.any(AbortSignal),
    );
    expect(
      processMocks.execFile.mock.calls.filter((call) =>
        call[1].includes("KEYCODE_PASTE"),
      ),
    ).toEqual([
      [
        expect.any(String),
        ["-s", target.serial, "shell", "input", "keyevent", "KEYCODE_PASTE"],
        expect.any(Object),
        expect.any(Function),
      ],
    ]);
    expect(
      processMocks.execFile.mock.calls.some(
        (call) =>
          call[1].includes(text) ||
          call[1].includes("KEYCODE_ENTER") ||
          call[1].includes("text"),
      ),
    ).toBe(false);
  });

  it("keeps phone and TV text requests bound to their own port, token and serial", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    await runtime.launch(app, "tv", settings, vi.fn());
    await Promise.all(
      fixture.children.map((target) => writeClipboardAdvertisement(target)),
    );
    await runtime.sendText("tv", "电视输入", settings);
    await runtime.sendText("phone", "手机输入", settings);
    expect(clipboardMock.mock.calls.map((call) => call[0])).toEqual([
      fixture.children[1].grpcPort,
      fixture.children[0].grpcPort,
    ]);
    const pasted = processMocks.execFile.mock.calls.filter((call) =>
      call[1].includes("KEYCODE_PASTE"),
    );
    expect(pasted.map((call) => call[1][1])).toEqual([
      fixture.children[1].serial,
      fixture.children[0].serial,
    ]);
  });

  it.each([
    ["grpc.port", "1"],
    ["port.serial", "5550"],
    ["avd.id", "Another_AVD"],
    ["grpc.token", ""],
    ["avd.dir", "/missing/other.avd"],
  ])(
    "rejects an advertisement with mismatched %s before sending text",
    async (key, value) => {
      const fixture = nativeRuntimeFixture();
      await runtime.launch(app, "phone", settings, vi.fn());
      await writeClipboardAdvertisement(fixture.children[0], { [key]: value });
      await expect(
        runtime.sendText("phone", "秘密文本", settings),
      ).rejects.toThrow("无法验证模拟器");
      expect(clipboardMock).not.toHaveBeenCalled();
      expect(
        processMocks.execFile.mock.calls.some((call) =>
          call[1].includes("KEYCODE_PASTE"),
        ),
      ).toBe(false);
    },
  );

  it("rejects a stale POSIX discovery PID even if all advertised fields match", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    fixture.children[0].discoveryPath = join(
      dirname(fixture.children[0].discoveryPath),
      "pid_99999.ini",
    );
    await writeClipboardAdvertisement(fixture.children[0]);
    Object.defineProperty(process, "platform", { value: "darwin" });
    await expect(runtime.sendText("phone", "你好", settings)).rejects.toThrow(
      "无法验证模拟器",
    );
    expect(clipboardMock).not.toHaveBeenCalled();
  });

  it("allows the Windows QEMU child PID to differ from its live launcher while pinning all other fields", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    fixture.children[0].discoveryPath = join(
      dirname(fixture.children[0].discoveryPath),
      "pid_99999.ini",
    );
    await writeClipboardAdvertisement(fixture.children[0]);
    Object.defineProperty(process, "platform", { value: "win32" });
    await runtime.sendText("phone", "你好", settings);
    expect(clipboardMock).toHaveBeenCalledOnce();
  });

  it("does not open a device or use an external/native-unowned session to send text", async () => {
    runtime = new AndroidRuntime(undefined, {
      APK_CHECKER_DISPLAY_MODE: "native",
    });
    await expect(runtime.sendText("phone", "你好", settings)).rejects.toThrow(
      "请先打开",
    );
    expect(processMocks.execFile).not.toHaveBeenCalled();
    expect(processMocks.spawn).not.toHaveBeenCalled();
    expect(clipboardMock).not.toHaveBeenCalled();
  });

  it("does not send text to its owned headless installation session", async () => {
    nativeRuntimeFixture();
    await runtime.install(app, apkPath, "phone", settings, vi.fn());
    await expect(runtime.sendText("phone", "你好", settings)).rejects.toThrow(
      "请先打开",
    );
    expect(clipboardMock).not.toHaveBeenCalled();
  });

  it.each(["", "a\0b", "😀".repeat(4097), "\ud800"])(
    "rejects invalid clipboard text before any device command",
    async (text) => {
      await expect(runtime.sendText("phone", text, settings)).rejects.toThrow();
      expect(processMocks.execFile).not.toHaveBeenCalled();
      expect(clipboardMock).not.toHaveBeenCalled();
    },
  );

  it("never pastes after the RPC fails and never retries set or paste", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    await writeClipboardAdvertisement(fixture.children[0]);
    clipboardMock.mockRejectedValue(new Error("模拟器文本连接失败。"));
    await expect(runtime.sendText("phone", "你好", settings)).rejects.toThrow(
      "模拟器文本连接失败",
    );
    expect(clipboardMock).toHaveBeenCalledOnce();
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("KEYCODE_PASTE"),
      ),
    ).toBe(false);
  });

  it("cancels an in-flight clipboard request on quit and never sends paste afterwards", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    await writeClipboardAdvertisement(fixture.children[0]);
    let finishRpc!: () => void;
    clipboardMock.mockImplementation(
      () =>
        new Promise<void>((resolveRpc) => {
          finishRpc = resolveRpc;
        }),
    );
    const sending = runtime.sendText("phone", "你好", settings);
    const cancelled = expect(sending).rejects.toThrow("正在退出");
    await vi.waitFor(() => expect(clipboardMock).toHaveBeenCalledOnce());
    const signal = clipboardMock.mock.calls[0][3] as AbortSignal;
    await runtime.dispose();
    expect(signal.aborted).toBe(true);
    finishRpc();
    await cancelled;
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("KEYCODE_PASTE"),
      ),
    ).toBe(false);
  });

  it("does not paste if the owned window closes while setting the clipboard", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    await writeClipboardAdvertisement(fixture.children[0]);
    clipboardMock.mockImplementation(async () =>
      fixture.children[0].child.emit("exit", 0, null),
    );
    await expect(runtime.sendText("phone", "你好", settings)).rejects.toThrow(
      "窗口已关闭",
    );
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("KEYCODE_PASTE"),
      ),
    ).toBe(false);
  });

  it("revalidates exact AVD identity after clipboard readback before paste", async () => {
    const fixture = nativeRuntimeFixture();
    await runtime.launch(app, "phone", settings, vi.fn());
    await writeClipboardAdvertisement(fixture.children[0]);
    const normal = output;
    clipboardMock.mockImplementation(async () => {
      output = (args) =>
        args.includes("emu") && args.includes("name")
          ? "Foreign_AVD\nOK\n"
          : normal(args);
    });
    await expect(runtime.sendText("phone", "你好", settings)).rejects.toThrow(
      "目标模拟器未连接",
    );
    expect(
      processMocks.execFile.mock.calls.some((call) =>
        call[1].includes("KEYCODE_PASTE"),
      ),
    ).toBe(false);
  });
});
