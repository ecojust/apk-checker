import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function fakeChild(): ChildProcess {
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
      if (args.includes("resolve-activity"))
        return "org.example.app/.Main$Inner\n";
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
      ["-s", "emulator-5556", "install", "-r", apkPath],
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
  });

  it("does not open a window when an application has no launcher", async () => {
    const normal = output;
    output = (args) =>
      args.includes("resolve-activity") ? "No activity found" : normal(args);
    await expect(
      runtime.launch(app, "phone", settings, vi.fn()),
    ).rejects.toThrow("没有可启动");
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
});
