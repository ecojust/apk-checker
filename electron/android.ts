import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { createServer } from "node:net";
import { displayCommand, hasVideoTexture } from "./display";
import type {
  DeviceMode,
  LibraryApp,
  RuntimeStatus,
  Settings,
} from "../src/shared/types";

const COMMAND_TIMEOUT = 15_000;
const BOOT_TIMEOUT = 180_000;
const PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const COMPONENT_PATTERN =
  /^([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+)\/[A-Za-z0-9_.$]+$/;
const AVD_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
type Progress = (message: string) => void;
type Device = RuntimeStatus["devices"][number];
interface OwnedEmulator {
  child: ChildProcess;
  adb: string;
  serial: string;
  avd: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function exists(path: string, executable = false): Promise<boolean> {
  try {
    await access(
      path,
      executable && process.platform !== "win32"
        ? constants.X_OK
        : constants.F_OK,
    );
    return !executable || (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function run(
  file: string,
  args: string[],
  timeout = COMMAND_TIMEOUT,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      file,
      args,
      {
        timeout,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
        env,
      },
      (error, stdout, stderr) => {
        if (error) {
          // adb can put a generic prefix on stderr and the actual install error
          // on stdout. Keep a bounded tail from each instead of discarding one.
          const details = [
            stdout.trim() && `stdout:\n${stdout.trim().slice(-3000)}`,
            stderr.trim() && `stderr:\n${stderr.trim().slice(-3000)}`,
            error.code !== undefined && error.code !== null
              ? `退出代码：${error.code}`
              : "",
            error.signal ? `信号：${error.signal}` : "",
            error.message ? error.message.slice(-1500) : "",
          ].filter(Boolean).join("\n");
          reject(new Error(
            `${error.killed ? "命令被终止或执行超时：" : ""}${details || "命令执行失败，未返回诊断信息。"}`,
          ));
        } else resolveOutput(stdout);
      },
    );
  });
}

function childHasExited(child: ChildProcess): boolean {
  return child.pid === undefined ||
    child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(
  child: ChildProcess,
  timeout: number,
): Promise<boolean> {
  if (childHasExited(child)) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolveExit(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    child.once("exit", onExit);
    if (childHasExited(child)) finish(true);
  });
}

export function parseDevices(output: string): Device[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = line.match(
      /^(\S+)\s+(device|offline|unauthorized|recovery|bootloader)(?:\s|$)/,
    );
    return match ? [{ serial: match[1], state: match[2], avd: "" }] : [];
  });
}

export function parseResolvedActivity(
  output: string,
  packageName: string,
): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => {
      const match = line.match(COMPONENT_PATTERN);
      return match?.[1] === packageName;
    });
}

export function validatePackageName(packageName: string): void {
  if (!PACKAGE_PATTERN.test(packageName))
    throw new Error("APK 包名无效，无法执行 Android 命令。");
}

function configuredAvd(
  settings: Settings,
  mode: DeviceMode,
  managed = false,
): string {
  const avd = mode === "phone" ? settings.phoneAvd : settings.tvAvd;
  if (!avd)
    throw new Error(
      managed
        ? `请先在运行环境中准备${mode === "phone" ? "手机" : "电视"}模拟器。`
        : `请先在运行环境中选择${mode === "phone" ? "手机" : "电视"}虚拟设备（AVD）。`,
    );
  if (!AVD_PATTERN.test(avd))
    throw new Error("虚拟设备名称无效，请重新选择 AVD。");
  if (settings.phoneAvd && settings.phoneAvd === settings.tvAvd) {
    throw new Error("手机模式与电视模式需要选择两个不同的虚拟设备。");
  }
  return avd;
}

export class AndroidRuntime {
  private ownedEmulators = new Map<string, OwnedEmulator>();
  private windows = new Map<string, ChildProcess>();
  private disposed = false;
  private disposal?: Promise<void>;

  private readonly environment: NodeJS.ProcessEnv;
  private readonly privateAvdHome: boolean;
  private readonly privateAdbSocket?: string;
  private readonly adbExecutables = new Set<string>();
  private usedPrivateAdb?: string;

  constructor(
    private readonly onRuntimeError?: (message: string) => void,
    envOverrides: NodeJS.ProcessEnv = {},
  ) {
    this.environment = { ...process.env, ...envOverrides };
    this.privateAvdHome = Boolean(envOverrides.ANDROID_AVD_HOME);
    // Only a manager-supplied nondefault loopback socket is ours to shut down.
    // An inherited ADB_SERVER_SOCKET (or the normal 5037 server) is never owned.
    const socket = envOverrides.ADB_SERVER_SOCKET;
    const socketMatch = socket?.match(/^tcp:(?:127\.0\.0\.1|localhost):(\d+)$/);
    const port = Number(socketMatch?.[1]);
    if (socketMatch && port > 1023 && port <= 65535 && port !== 5037) {
      this.privateAdbSocket = socket;
    }
  }

  private run(
    file: string,
    args: string[],
    timeout = COMMAND_TIMEOUT,
    duringDisposal = false,
  ): Promise<string> {
    if (this.disposed && !duringDisposal) {
      return Promise.reject(new Error("应用正在退出，操作已取消。"));
    }
    if (this.privateAdbSocket && this.adbExecutables.has(file)) {
      this.usedPrivateAdb = file;
    }
    return run(file, args, timeout, this.environment);
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("应用正在退出，操作已取消。");
  }

  private async sdkRoot(settings: Settings): Promise<string> {
    if (settings.sdkPath.trim()) return resolve(settings.sdkPath.trim());
    const home = homedir();
    const candidates = [
      this.environment.ANDROID_SDK_ROOT,
      this.environment.ANDROID_HOME,
      process.platform === "darwin"
        ? join(home, "Library", "Android", "sdk")
        : undefined,
      process.platform === "win32"
        ? join(
            this.environment.LOCALAPPDATA || join(home, "AppData", "Local"),
            "Android",
            "Sdk",
          )
        : undefined,
      join(home, "Android", "Sdk"),
      join(home, "Android", "sdk"),
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates)
      if (
        await stat(candidate)
          .then((info) => info.isDirectory())
          .catch(() => false)
      )
        return resolve(candidate);
    return "";
  }

  private exe(name: string): string {
    return process.platform === "win32" ? `${name}.exe` : name;
  }

  private async sdkTool(
    settings: Settings,
    folder: string,
    name: string,
  ): Promise<string> {
    const root = await this.sdkRoot(settings);
    const path = root ? join(root, folder, this.exe(name)) : "";
    if (!path || !(await exists(path, true))) return "";
    if (folder === "platform-tools" && name === "adb")
      this.adbExecutables.add(path);
    return path;
  }

  private async requireAdb(settings: Settings): Promise<string> {
    const adb = await this.sdkTool(settings, "platform-tools", "adb");
    if (!adb)
      throw new Error(
        this.privateAvdHome
          ? "内置连接组件缺失，请在运行环境中重新准备模拟器。"
          : "未找到 adb，请安装 Android SDK Platform-Tools，并在运行环境中设置 SDK 路径。",
      );
    return adb;
  }

  private async scrcpyPath(settings: Settings): Promise<string> {
    if (settings.scrcpyPath.trim()) {
      const path = resolve(settings.scrcpyPath.trim());
      return (await exists(path, true)) ? path : "";
    }
    const candidates = [
      ...(this.environment.PATH || "")
        .split(delimiter)
        .filter(Boolean)
        .map((folder) => join(folder, this.exe("scrcpy"))),
      "/opt/homebrew/bin/scrcpy",
      "/usr/local/bin/scrcpy",
      "/usr/bin/scrcpy",
    ];
    for (const path of candidates) if (await exists(path, true)) return path;
    return "";
  }

  async getAaptPath(settings: Settings): Promise<string> {
    const sdk = await this.sdkRoot(settings);
    if (sdk) {
      const versions = await readdir(join(sdk, "build-tools")).catch(
        () => [] as string[],
      );
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const version of versions) {
        for (const tool of ["aapt", "aapt2"]) {
          const path = join(sdk, "build-tools", version, this.exe(tool));
          if (await exists(path, true)) return path;
        }
      }
    }
    throw new Error(
      "未找到 aapt / aapt2。请通过 Android Studio 的 SDK Manager 安装 Android SDK Build-Tools。",
    );
  }

  private async avds(settings: Settings): Promise<string[]> {
    const emulator = await this.sdkTool(settings, "emulator", "emulator");
    if (!emulator) return [];
    const output = await this.run(emulator, ["-list-avds"]);
    return output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter((value) => AVD_PATTERN.test(value));
  }

  private async devices(adb: string): Promise<Device[]> {
    // ADB may enumerate USB/network devices internally. Product operations and
    // status never expose or target them, even if a server reports them.
    const devices = parseDevices(await this.run(adb, ["devices"])).filter(
      (device) => /^emulator-\d+$/.test(device.serial),
    );
    return Promise.all(
      devices.map(async (device) => {
        if (/^emulator-\d+$/.test(device.serial) && device.state === "device") {
          const name = await this.run(
            adb,
            ["-s", device.serial, "emu", "avd", "name"],
            5000,
          ).catch(() => "");
          device.avd =
            name
              .split(/\r?\n/)
              .map((line) => line.trim())
              .find((line) => line !== "OK" && AVD_PATTERN.test(line)) || "";
        }
        return device;
      }),
    );
  }

  async getStatus(settings: Settings): Promise<RuntimeStatus> {
    const [sdk, adb, emulator, aapt, scrcpy] = await Promise.all([
      this.sdkRoot(settings),
      this.sdkTool(settings, "platform-tools", "adb"),
      this.sdkTool(settings, "emulator", "emulator"),
      this.getAaptPath(settings).catch(() => ""),
      this.scrcpyPath(settings),
    ]);
    const status: RuntimeStatus = {
      sdkFound: Boolean(
        sdk &&
          (await stat(sdk)
            .then((info) => info.isDirectory())
            .catch(() => false)),
      ),
      adbFound: Boolean(adb),
      emulatorFound: Boolean(emulator),
      aaptFound: Boolean(aapt),
      scrcpyFound: Boolean(scrcpy),
      avds: [],
      devices: [],
      issues: [],
    };
    if (!status.sdkFound)
      status.issues.push(
        this.privateAvdHome
          ? "内置运行环境尚未准备完成。"
          : "请安装 Android SDK，并设置 SDK 路径。",
      );
    if (!adb)
      status.issues.push(
        this.privateAvdHome
          ? "内置连接组件尚未准备完成。"
          : "缺少 Platform-Tools（adb）。",
      );
    if (!emulator)
      status.issues.push(
        this.privateAvdHome
          ? "内置模拟器尚未准备完成。"
          : "缺少 Android Emulator。",
      );
    if (!scrcpy)
      status.issues.push(
        this.privateAvdHome
          ? "内置显示组件尚未准备完成。"
          : "缺少 scrcpy，暂时无法打开应用显示窗口。",
      );
    await Promise.all([
      emulator
        ? this.avds(settings)
            .then((avds) => {
              status.avds = avds;
            })
            .catch((error) => {
              status.issues.push(`读取 AVD 失败：${messageOf(error)}`);
            })
        : undefined,
      adb
        ? this.devices(adb)
            .then((devices) => {
              status.devices = this.privateAvdHome
                ? devices.filter(
                    (device) =>
                      device.avd === settings.phoneAvd ||
                      device.avd === settings.tvAvd,
                  )
                : devices;
            })
            .catch((error) => {
              status.issues.push(`连接 adb 失败：${messageOf(error)}`);
            })
        : undefined,
    ]);
    if (emulator && !status.avds.length)
      status.issues.push(
        this.privateAvdHome
          ? "尚未准备模拟器，请在运行环境中准备手机或电视模式。"
          : "尚未发现虚拟设备，请在 Android Studio Device Manager 创建手机和 Android TV AVD。",
      );
    if (settings.phoneAvd && !status.avds.includes(settings.phoneAvd))
      status.issues.push(
        this.privateAvdHome
          ? "手机模拟器尚未准备完成。"
          : `手机虚拟设备 ${settings.phoneAvd} 不存在。`,
      );
    if (settings.tvAvd && !status.avds.includes(settings.tvAvd))
      status.issues.push(
        this.privateAvdHome
          ? "电视模拟器尚未准备完成。"
          : `电视虚拟设备 ${settings.tvAvd} 不存在。`,
      );
    return status;
  }

  // Read AVD metadata when available so a phone image is not silently used as a TV.
  private async checkDeviceMode(avd: string, mode: DeviceMode): Promise<void> {
    const avdHome =
      this.environment.ANDROID_AVD_HOME ||
      join(
        this.environment.ANDROID_USER_HOME || join(homedir(), ".android"),
        "avd",
      );
    let avdDirectory = join(avdHome, `${avd}.avd`);
    const ini = await readFile(join(avdHome, `${avd}.ini`), "utf8").catch(
      () => "",
    );
    const customPath = ini.match(/^path=(.+)$/m)?.[1]?.trim();
    if (customPath) avdDirectory = customPath;
    const config = await readFile(
      join(avdDirectory, "config.ini"),
      "utf8",
    ).catch(() => "");
    if (!config) return;
    const tag = config.match(/^tag\.id\s*=\s*(.+)$/m)?.[1]?.trim();
    const characteristics = config
      .match(/^hw\.device\.name\s*=\s*(.+)$/m)?.[1]
      ?.trim();
    const isTv =
      tag?.includes("android-tv") ||
      tag?.includes("google-tv") ||
      /(?:^|_)tv(?:_|$)/i.test(characteristics || "");
    if (mode === "tv" && tag && !isTv)
      throw new Error(
        this.privateAvdHome
          ? "内置电视镜像配置不匹配，请重新准备电视模式。"
          : `AVD「${avd}」不是 Android TV 设备，请在运行环境中选择电视虚拟设备。`,
      );
    if (mode === "phone" && isTv)
      throw new Error(
        this.privateAvdHome
          ? "内置手机镜像配置不匹配，请重新准备手机模式。"
          : `AVD「${avd}」是电视设备，请在运行环境中选择手机虚拟设备。`,
      );
  }

  private async freePort(devices: Device[]): Promise<number> {
    const occupied = new Set(
      devices.map((device) => Number(device.serial.replace("emulator-", ""))),
    );
    const canBind = (port: number) =>
      new Promise<boolean>((resolveAvailable) => {
        const server = createServer();
        server.once("error", () => resolveAvailable(false));
        server.listen(port, "127.0.0.1", () =>
          server.close(() => resolveAvailable(true)),
        );
      });
    for (let port = 5554; port <= 5682; port += 2) {
      if (
        !occupied.has(port) &&
        (await canBind(port)) &&
        (await canBind(port + 1))
      )
        return port;
    }
    throw new Error(
      "没有可用的 Android 模拟器端口，请关闭部分虚拟设备后重试。",
    );
  }

  private async ensureDevice(
    settings: Settings,
    mode: DeviceMode,
    progress: Progress,
  ): Promise<{ adb: string; serial: string; avd: string }> {
    this.assertActive();
    const avd = configuredAvd(settings, mode, this.privateAvdHome);
    const adb = await this.requireAdb(settings);
    if (!(await this.avds(settings)).includes(avd))
      throw new Error(
        this.privateAvdHome
          ? "内置模拟器配置缺失，请重新准备对应模式的运行环境。"
          : `找不到虚拟设备「${avd}」，请在运行环境中重新选择。`,
      );
    await this.checkDeviceMode(avd, mode);
    const devices = await this.devices(adb);
    const existing = devices.find(
      (device) => device.avd === avd && device.state === "device",
    );
    let serial = existing?.serial;
    let child: ChildProcess | undefined;
    let processError = "";
    let exited = false;
    if (!serial) {
      if (this.ownedEmulators.has(avd))
        throw new Error("该虚拟设备仍在启动，请稍后重试。");
      const emulator = await this.sdkTool(settings, "emulator", "emulator");
      if (!emulator)
        throw new Error(
          this.privateAvdHome
            ? "内置模拟器缺失，请重新准备运行环境。"
            : "未找到 Android Emulator，请在 SDK Manager 安装。",
        );
      const port = await this.freePort(devices);
      serial = `emulator-${port}`;
      progress(
        `正在启动${mode === "phone" ? "手机" : "电视"}虚拟设备「${avd}」，首次启动可能需要几分钟…`,
      );
      child = spawn(
        emulator,
        ["-avd", avd, "-port", String(port), "-no-window", "-no-boot-anim"],
        {
          stdio: ["ignore", "ignore", "pipe"],
          windowsHide: true,
          env: this.environment,
        },
      );
      this.ownedEmulators.set(avd, { child, adb, serial, avd });
      child.stderr?.on("data", (data) => {
        processError = (processError + String(data)).slice(-3000);
      });
      child.on("error", (error) => {
        processError = error.message;
        exited = true;
        if (this.ownedEmulators.get(avd)?.child === child) {
          this.ownedEmulators.delete(avd);
        }
      });
      child.on("exit", (code, signal) => {
        exited = true;
        const stillOwned = this.ownedEmulators.get(avd)?.child === child;
        if (stillOwned) this.ownedEmulators.delete(avd);
        processError = [
          `退出代码：${code ?? "无"}${signal ? `，信号：${signal}` : ""}`,
          processError,
        ].filter(Boolean).join("\n");
        if (
          stillOwned && !this.disposed &&
          (signal || (code !== null && code !== 0))
        ) {
          this.onRuntimeError?.(`模拟器「${avd}」意外退出：${processError}`);
        }
      });
    } else progress(`正在连接虚拟设备「${avd}」…`);
    const deadline = Date.now() + BOOT_TIMEOUT;
    while (Date.now() < deadline) {
      this.assertActive();
      if (exited)
        throw new Error(
          `虚拟设备启动失败：${processError || "模拟器进程已退出，请检查系统镜像和硬件虚拟化支持。"}`,
        );
      const name = await this.run(
        adb,
        ["-s", serial, "emu", "avd", "name"],
        3000,
      ).catch(() => "");
      if (
        name
          .split(/\r?\n/)
          .map((line) => line.trim())
          .includes(avd)
      ) {
        const booted = await this.run(
          adb,
          ["-s", serial, "shell", "getprop", "sys.boot_completed"],
          3000,
        ).catch(() => "");
        this.assertActive();
        if (exited)
          throw new Error(
            `虚拟设备启动失败：${processError || "模拟器进程已退出。"}`,
          );
        if (booted.trim() === "1") return { adb, serial, avd };
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
    }
    if (child) {
      const owned = this.ownedEmulators.get(avd);
      if (owned) {
        this.ownedEmulators.delete(avd);
        await this.stopEmulator(owned);
      }
    }
    throw new Error(
      this.privateAvdHome
        ? "模拟器启动超时（3 分钟）。请检查系统硬件虚拟化支持，重启应用后重试。"
        : "虚拟设备启动超时（3 分钟）。请检查硬件虚拟化、系统镜像架构，或先在 Android Studio 中启动此 AVD。",
    );
  }

  async install(
    app: LibraryApp,
    apkPath: string,
    mode: DeviceMode,
    settings: Settings,
    onProgress: Progress,
  ): Promise<{ avd: string }> {
    validatePackageName(app.packageName);
    const file = await stat(apkPath).catch(() => null);
    if (!file?.isFile()) throw new Error("APK 文件不存在，请重新导入。");
    const { adb, serial, avd } = await this.ensureDevice(
      settings,
      mode,
      onProgress,
    );
    onProgress(`正在安装 ${app.name}…`);
    const output = await this.run(
      adb,
      ["-s", serial, "install", "-r", apkPath],
      180_000,
    );
    if (!/^Success\s*$/m.test(output))
      throw new Error(`安装未完成：${output.trim() || "adb 未返回成功状态。"}`);
    onProgress(
      `${app.name} 已安装到${mode === "phone" ? "手机" : "电视"}桌面。`,
    );
    return { avd };
  }

  private assertInstalled(
    app: LibraryApp,
    mode: DeviceMode,
    settings: Settings,
  ): void {
    validatePackageName(app.packageName);
    const avd = configuredAvd(settings, mode, this.privateAvdHome);
    if (app.installed[mode]?.avd !== avd)
      throw new Error("此应用尚未安装到当前虚拟设备，请先安装。");
  }

  async launch(
    app: LibraryApp,
    mode: DeviceMode,
    settings: Settings,
    onProgress: Progress,
  ): Promise<void> {
    this.assertInstalled(app, mode, settings);
    const scrcpy = await this.scrcpyPath(settings);
    if (!scrcpy)
      throw new Error(
        this.privateAvdHome
          ? "内置显示组件缺失，请重新准备运行环境。"
          : "未找到 scrcpy。请先安装 scrcpy，并在运行环境中设置可执行文件路径。",
      );
    const { adb, serial } = await this.ensureDevice(settings, mode, onProgress);
    // Android 11 audio capture requires an unlocked foreground screen. These
    // commands affect only the explicitly selected emulator and cannot unlock a PIN.
    await this.run(adb, ["-s", serial, "shell", "input", "keyevent", "KEYCODE_WAKEUP"]).catch(() => undefined);
    await this.run(adb, ["-s", serial, "shell", "wm", "dismiss-keyguard"]).catch(() => undefined);
    const category =
      mode === "tv"
        ? "android.intent.category.LEANBACK_LAUNCHER"
        : "android.intent.category.LAUNCHER";
    const resolveActivity = async (launcherCategory: string) =>
      parseResolvedActivity(
        await this.run(adb, [
          "-s",
          serial,
          "shell",
          "cmd",
          "package",
          "resolve-activity",
          "--brief",
          "-a",
          "android.intent.action.MAIN",
          "-c",
          launcherCategory,
          app.packageName,
        ]),
        app.packageName,
      );
    onProgress(`正在打开 ${app.name}…`);
    let activity = await resolveActivity(category);
    if (!activity && mode === "tv") {
      onProgress(
        "应用没有电视启动入口，将在电视设备中使用普通启动入口；遥控器兼容性取决于应用。",
      );
      activity = await resolveActivity("android.intent.category.LAUNCHER");
    }
    if (!activity)
      throw new Error(
        "此 APK 没有可启动的应用入口，可能是插件、服务或不兼容当前设备。",
      );
    // adb shell joins arguments; quote the validated component to preserve Java inner-class '$'.
    const output = await this.run(
      adb,
      ["-s", serial, "shell", "am", "start", "-W", "-n", `'${activity}'`],
      45_000,
    );
    const launchStatus = output.match(/^Status:\s*(\S+)/im)?.[1];
    if (
      /^(?:Error|Exception)|Error type \d|Permission Denial|SecurityException/im.test(
        output,
      ) ||
      (launchStatus && launchStatus.toLowerCase() !== "ok")
    ) {
      throw new Error(`启动应用失败：${output.trim()}`);
    }
    this.assertActive();
    const previous = this.windows.get(serial);
    if (previous) {
      this.windows.delete(serial);
      previous.kill();
    }
    const display = displayCommand(scrcpy, [
        "--serial",
        serial,
        "--window-title",
        `${app.name} · ${mode === "phone" ? "手机模式" : "电视模式"} · APK Checker`,
      ]);
    const child = spawn(
      display.file,
      display.args,
      {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...this.environment, ADB: adb },
      },
    );
    this.windows.set(serial, child);
    let diagnostics = "";
    let started = false;
    let settled = false;
    await new Promise<void>((resolveLaunch, reject) => {
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.windows.get(serial) === child) this.windows.delete(serial);
        reject(new Error(message));
      };
      const timer = setTimeout(() => {
        fail(`显示窗口启动超时：15 秒内未收到视频画面。${diagnostics}`);
        child.kill();
      }, 15_000);
      const onOutput = (data: Buffer) => {
        diagnostics = (diagnostics + String(data)).slice(-4000);
        if (
          !settled &&
          hasVideoTexture(diagnostics)
        ) {
          settled = true;
          started = true;
          clearTimeout(timer);
          resolveLaunch();
        }
      };
      child.stdout?.on("data", onOutput);
      child.stderr?.on("data", onOutput);
      let exitReported = false;
      const handleExit = (error?: Error | null, code?: number | null) => {
        clearTimeout(timer);
        const currentWindow = this.windows.get(serial) === child;
        if (currentWindow) this.windows.delete(serial);
        const detail =
          error?.message || diagnostics || `退出代码：${code ?? "未知"}`;
        if (!started) fail(`显示窗口启动失败：${detail}`);
        else if (
          !exitReported &&
          !this.disposed &&
          currentWindow &&
          (error || (code !== null && code !== undefined && code !== 0))
        ) {
          exitReported = true;
          this.onRuntimeError?.(`显示窗口已退出：${detail}`);
        }
      };
      child.once("error", (error) => handleExit(error));
      child.once("exit", (code) => handleExit(null, code));
    });
    this.assertActive();
    onProgress(`${app.name} 已在独立窗口打开。`);
  }

  async uninstall(
    app: LibraryApp,
    mode: DeviceMode,
    settings: Settings,
    onProgress: Progress,
  ): Promise<void> {
    this.assertInstalled(app, mode, settings);
    const { adb, serial } = await this.ensureDevice(settings, mode, onProgress);
    onProgress(`正在卸载 ${app.name}…`);
    // An externally reset AVD may no longer have the package. Clear the stale record safely.
    const installed = await this.run(adb, [
      "-s",
      serial,
      "shell",
      "pm",
      "list",
      "packages",
      app.packageName,
    ]);
    if (!installed.split(/\r?\n/).includes(`package:${app.packageName}`))
      return;
    const output = await this.run(
      adb,
      ["-s", serial, "uninstall", app.packageName],
      60_000,
    );
    if (!/^Success\s*$/m.test(output))
      throw new Error(`卸载失败：${output.trim()}`);
    onProgress(`${app.name} 已卸载。`);
  }

  private async stopEmulator(owned: OwnedEmulator): Promise<void> {
    if (childHasExited(owned.child)) return;
    let gracefulShutdown = false;
    // Verify the AVD identity before issuing a shutdown: never stop an externally owned device.
    try {
      const name = await this.run(
        owned.adb,
        ["-s", owned.serial, "emu", "avd", "name"],
        2000,
        true,
      );
      if (
        name
          .split(/\r?\n/)
          .map((line) => line.trim())
          .includes(owned.avd)
      ) {
        await this.run(
          owned.adb,
          ["-s", owned.serial, "emu", "kill"],
          3000,
          true,
        );
        gracefulShutdown = true;
      }
    } catch {
      /* A booting / failed emulator may not expose its console yet. */
    }
    // The console acknowledgement precedes snapshot writes and process exit.
    // Keep the directory and private ADB server alive until QEMU has stopped.
    if (gracefulShutdown && await waitForChildExit(owned.child, 15_000)) return;
    if (childHasExited(owned.child)) return;
    // Windows emulator.exe launches QEMU; terminating only the launcher leaves QEMU running.
    const windowsProcessTree = process.platform === "win32" && owned.child.pid;
    if (windowsProcessTree) {
      await this.run(
        "taskkill",
        ["/PID", String(owned.child.pid), "/T", "/F"],
        3000,
        true,
      ).catch(() => undefined);
    } else {
      owned.child.kill("SIGTERM");
    }
    if (await waitForChildExit(owned.child, 3000)) return;
    if (!windowsProcessTree) {
      owned.child.kill("SIGKILL");
      if (await waitForChildExit(owned.child, 3000)) return;
    }
    throw new Error(
      `无法确认模拟器「${owned.avd}」已经关闭，已保留运行环境数据，请关闭该进程后重试。`,
    );
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    for (const child of this.windows.values()) child.kill();
    this.windows.clear();
    const owned = [...this.ownedEmulators.values()];
    this.ownedEmulators.clear();
    this.disposal = Promise.allSettled(
      owned.map((emulator) => this.stopEmulator(emulator)),
    ).then(async (results) => {
      if (this.privateAdbSocket && this.usedPrivateAdb) {
        // Use the exact binary and private environment previously invoked here.
        await this.run(this.usedPrivateAdb, ["kill-server"], 3000, true).catch(
          () => undefined,
        );
      }
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    });
    return this.disposal;
  }
}
