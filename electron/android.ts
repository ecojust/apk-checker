import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  access,
  lstat,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve } from "node:path";
import { createServer } from "node:net";
import { displayCommand, hasVideoTexture } from "./display";
import { parseForegroundActivity, parseKeyguardLocked } from "./launch-state";
import {
  setEmulatorClipboard,
  validateClipboardText,
} from "./emulator-clipboard";
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
  nativeWindow: boolean;
  grpcPort?: number;
  avdDirectory?: string;
}

// QEMU can exit with code 0 after failing to restore a device from Quick Boot.
// Match the fatal state-loading diagnostic, not ordinary snapshot/codec warnings.
const SNAPSHOT_RESTORE_ERROR = /error while loading state for instance\b/i;

function emulatorDiagnostics(child: ChildProcess) {
  const output = { stdout: "", stderr: "" };
  let snapshotError = "";
  let snapshotStream: "stdout" | "stderr" | undefined;
  let snapshotLineComplete = false;
  let closed = false;
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (data) => {
      const text = String(data);
      const combined = output[stream] + text;
      if (snapshotStream === stream && !snapshotLineComplete) {
        snapshotError = (snapshotError + text.split(/\r?\n/, 1)[0]).slice(0, 1500);
        snapshotLineComplete = text.includes("\n") || snapshotError.length >= 1500;
      }
      if (!snapshotError) {
        const lines = combined.split(/\r?\n/);
        const index = lines.findIndex((line) => SNAPSHOT_RESTORE_ERROR.test(line));
        if (index !== -1) {
          snapshotError = lines[index].slice(0, 1500);
          snapshotStream = stream;
          snapshotLineComplete = index < lines.length - 1 || snapshotError.length >= 1500;
        }
      }
      output[stream] = combined.slice(-3000);
    });
  }
  child.once("close", () => { closed = true; });
  return {
    get snapshotError() { return snapshotError; },
    details() {
      return [
        snapshotError && `快照恢复错误：${snapshotError}`,
        output.stdout.trim() && `stdout:\n${output.stdout.trim()}`,
        output.stderr.trim() && `stderr:\n${output.stderr.trim()}`,
      ].filter(Boolean).join("\n");
    },
    // exit may precede the last output chunk. Bound the drain wait in case a
    // descendant keeps a pipe open; a closed pipe needs no additional delay.
    drain(): Promise<void> {
      if (closed) return Promise.resolve();
      return new Promise((resolveDrain) => {
        const finish = () => {
          clearTimeout(timer);
          child.removeListener("close", finish);
          resolveDrain();
        };
        const timer = setTimeout(finish, 1000);
        child.once("close", finish);
        if (closed) finish();
      });
    },
  };
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
          ]
            .filter(Boolean)
            .join("\n");
          reject(
            new Error(
              `${error.killed ? "命令被终止或执行超时：" : ""}${details || "命令执行失败，未返回诊断信息。"}`,
            ),
          );
        } else resolveOutput(stdout);
      },
    );
  });
}

function childHasExited(child: ChildProcess): boolean {
  return (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  );
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
  private stoppingEmulators = new Set<Promise<void>>();
  private windows = new Map<string, ChildProcess>();
  private disposed = false;
  private disposal?: Promise<void>;
  private clipboardRequests = new Set<AbortController>();
  private textSending = false;

  private readonly environment: NodeJS.ProcessEnv;
  private readonly privateAvdHome: boolean;
  private readonly nativeDisplay: boolean;
  private readonly privateAdbSocket?: string;
  private readonly adbExecutables = new Set<string>();
  private usedPrivateAdb?: string;

  constructor(
    private readonly onRuntimeError?: (message: string) => void,
    envOverrides: NodeJS.ProcessEnv = {},
  ) {
    this.environment = { ...process.env, ...envOverrides };
    this.privateAvdHome = Boolean(envOverrides.ANDROID_AVD_HOME);
    this.nativeDisplay = envOverrides.APK_CHECKER_DISPLAY_MODE === "native";
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
    if (!this.nativeDisplay && !scrcpy)
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
    const avdDirectory = await this.avdDirectory(avd);
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

  private async avdDirectory(avd: string): Promise<string> {
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
    return resolve(avdDirectory);
  }

  private async freeGrpcPort(): Promise<number> {
    return new Promise((resolvePort, reject) => {
      const server = createServer();
      server.once("error", () =>
        reject(new Error("无法分配本地文本输入端口，请稍后重试。")),
      );
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address !== "string") resolvePort(address.port);
          else reject(new Error("无法分配本地文本输入端口，请稍后重试。"));
        });
      });
    });
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
    requireNativeWindow = false,
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
    let devices = await this.devices(adb);
    const previous = this.ownedEmulators.get(avd);
    let coldBoot = false;
    if (requireNativeWindow && previous && !previous.nativeWindow) {
      progress("正在保存模拟器状态并打开原生窗口…");
      // -no-window selects a headless executable without Qt. Its process must
      // fully exit before the same AVD can be opened with the native display.
      this.ownedEmulators.delete(avd);
      try {
        await this.stopEmulator(previous);
      } catch (error) {
        if (!childHasExited(previous.child))
          this.ownedEmulators.set(avd, previous);
        throw error;
      }
      this.assertActive();
      devices = (await this.devices(adb)).filter(
        (device) => device.serial !== previous.serial,
      );
      // Headless and Qt use different display backends. Keep the same userdata
      // while avoiding restoration of the previous backend's in-memory state.
      coldBoot = true;
    }
    const existing = devices.find(
      (device) => device.avd === avd && device.state === "device",
    );
    if (requireNativeWindow && existing && !this.ownedEmulators.has(avd)) {
      // A matching device may have been started by another program. Never
      // stop it merely to change display modes.
      await this.assertNativeWindow(adb, existing.serial, false);
    }
    let firstFailure = "";
    try {
      for (;;) {
        this.assertActive();
        let serial = existing?.serial;
        let owned: OwnedEmulator | undefined;
        let diagnostics: ReturnType<typeof emulatorDiagnostics> | undefined;
        let processError = "";
        let exited = false;
        let booting = true;
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
          const grpcPort = requireNativeWindow
            ? await this.freeGrpcPort()
            : undefined;
          const avdDirectory = requireNativeWindow
            ? await this.avdDirectory(avd)
            : undefined;
          serial = `emulator-${port}`;
          progress(
            `正在启动${mode === "phone" ? "手机" : "电视"}虚拟设备「${avd}」，首次启动可能需要几分钟…`,
          );
          // Port discovery and progress callbacks may yield to application exit.
          this.assertActive();
          const child = spawn(
            emulator,
            [
              "-avd", avd, "-port", String(port),
              ...(requireNativeWindow
                ? ["-grpc", String(grpcPort), "-grpc-use-token"]
                : ["-no-window"]),
              "-no-boot-anim",
              ...(coldBoot ? ["-no-snapshot-load"] : []),
            ],
            {
              stdio: ["ignore", "pipe", "pipe"],
              windowsHide: !requireNativeWindow,
              env: this.environment,
            },
          );
          owned = { child, adb, serial, avd, nativeWindow: requireNativeWindow, grpcPort, avdDirectory };
          this.ownedEmulators.set(avd, owned);
          diagnostics = emulatorDiagnostics(child);
          child.on("error", (error) => {
            processError = error.message;
            exited = true;
            if (childHasExited(child) && this.ownedEmulators.get(avd)?.child === child)
              this.ownedEmulators.delete(avd);
          });
          child.on("exit", (code, signal) => {
            exited = true;
            const stillOwned = this.ownedEmulators.get(avd)?.child === child;
            if (stillOwned) this.ownedEmulators.delete(avd);
            processError = `退出代码：${code ?? "无"}${signal ? `，信号：${signal}` : ""}`;
            // Startup failures are returned by this operation, after any recovery.
            // Do not send an error notification for a recoverable first attempt.
            if (stillOwned && !booting && !this.disposed && (signal || (code !== null && code !== 0)))
              this.onRuntimeError?.(`模拟器「${avd}」意外退出：${processError}\n${diagnostics?.details() || ""}`);
          });
        } else progress(`正在连接虚拟设备「${avd}」…`);

        const details = () => [processError, diagnostics?.details()].filter(Boolean).join("\n");
        const checkStartup = async () => {
          this.assertActive();
          if (exited && owned && childHasExited(owned.child)) await diagnostics?.drain();
          this.assertActive();
          if (exited || diagnostics?.snapshotError)
            throw new Error(`虚拟设备启动失败：${details() || "模拟器进程已退出。"}`);
        };
        const stopOwned = async () => {
          if (!owned) return;
          if (this.ownedEmulators.get(avd) === owned) this.ownedEmulators.delete(avd);
          try {
            await this.stopEmulator(owned);
          } catch (error) {
            if (!childHasExited(owned.child)) this.ownedEmulators.set(avd, owned);
            throw error;
          }
        };
        let stage = "等待目标模拟器连接";
        let lastAdbError = "";
        const deadline = Date.now() + BOOT_TIMEOUT;
        try {
          while (Date.now() < deadline) {
            await checkStartup();
            const name = await this.run(adb, ["-s", serial, "emu", "avd", "name"], 3000)
              .catch((error) => { lastAdbError = messageOf(error).slice(-1500); return ""; });
            await checkStartup();
            if (name.split(/\r?\n/).map((line) => line.trim()).includes(avd)) {
              stage = "已连接目标模拟器，等待 Android 完成启动";
              const booted = await this.run(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], 3000)
                .catch((error) => { lastAdbError = messageOf(error).slice(-1500); return ""; });
              await checkStartup();
              if (booted.trim() === "1") {
                if (requireNativeWindow) await this.assertNativeWindow(adb, serial, true);
                await checkStartup();
                booting = false;
                return { adb, serial, avd };
              }
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 1200));
          }
          throw new Error([
            `模拟器启动超时（3 分钟）：${stage}。`,
            lastAdbError && `最近的连接错误：${lastAdbError}`,
            details(),
          ].filter(Boolean).join("\n"));
        } catch (error) {
          // Disposal owns shutdown after it clears the map; do not race it or restart.
          this.assertActive();
          const recover = Boolean(owned && diagnostics?.snapshotError && !coldBoot);
          try {
            await stopOwned();
          } catch (stopError) {
            throw new Error([messageOf(error), messageOf(stopError)].join("\n"));
          }
          this.assertActive();
          if (recover) {
            await diagnostics?.drain();
            this.assertActive();
            firstFailure = `首次启动失败：${details()}`;
            coldBoot = true;
            progress("快照恢复失败，正在冷启动模拟器；已安装应用和数据将保留…");
            this.assertActive();
            devices = (await this.devices(adb)).filter((device) => device.serial !== owned!.serial);
            continue;
          }
          throw error;
        }
      }
    } catch (error) {
      if (!firstFailure || this.disposed) throw error;
      throw new Error(`${firstFailure}\n冷启动失败：${messageOf(error)}`);
    }
  }

  private async assertNativeWindow(
    adb: string,
    serial: string,
    managed: boolean,
  ): Promise<void> {
    const output = await this.run(
      adb,
      ["-s", serial, "emu", "avd", "windowtype"],
      5000,
    );
    if (!/^windowtype=qtwindow\s*$/m.test(output)) {
      throw new Error(
        managed
          ? "模拟器原生窗口未就绪，请关闭该模拟器后重新打开应用。"
          : "当前模拟器没有可显示的窗口，请先关闭它再重试。",
      );
    }
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
    const userId = await this.currentUser(adb, serial);
    onProgress(`正在安装 ${app.name}…`);
    const output = await this.run(
      adb,
      ["-s", serial, "install", "--user", String(userId), "-r", apkPath],
      180_000,
    );
    if (!/^Success\s*$/m.test(output))
      throw new Error(`安装未完成：${output.trim() || "adb 未返回成功状态。"}`);
    this.assertActive();
    await this.assertPackagePresent(adb, serial, userId, app.packageName);
    onProgress(
      `${app.name} 已安装到${mode === "phone" ? "手机" : "电视"}模拟器，可从 APK Checker 桌面打开。`,
    );
    return { avd };
  }

  private async currentUser(adb: string, serial: string): Promise<number> {
    const output = (await this.run(adb, ["-s", serial, "shell", "am", "get-current-user"], 3000)).trim();
    this.assertActive();
    const userId = Number(output);
    if (!/^\d+$/.test(output) || !Number.isSafeInteger(userId) || userId > 2_147_483_647)
      throw new Error("无法确认模拟器当前 Android 用户，请稍后重试。");
    return userId;
  }

  private async assertPackagePresent(adb: string, serial: string, userId: number, packageName: string): Promise<void> {
    const output = await this.run(adb, ["-s", serial, "shell", "pm", "list", "packages", "--user", String(userId), packageName]);
    this.assertActive();
    if (!output.split(/\r?\n/).some((line) => line.trim() === `package:${packageName}`))
      throw new Error(`未在模拟器当前用户中找到此应用。请在应用卡片的更多操作中选择“重新安装（保留数据）”。\n包名：${packageName}；Android 用户：${userId}`);
  }

  private async waitForUnlockedUser(adb: string, serial: string, userId: number): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const state = (await this.run(adb, ["-s", serial, "shell", "am", "get-started-user-state", String(userId)], 3000)).trim();
      this.assertActive();
      if (state === "RUNNING_UNLOCKED") return;
      if (!/^RUNNING_(?:LOCKED|UNLOCKING)$/.test(state))
        throw new Error("模拟器当前用户尚未就绪，请在模拟器窗口完成启动或解锁后重试。");
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      this.assertActive();
    }
    throw new Error("模拟器当前用户尚未解锁，请在模拟器窗口完成解锁后重新打开应用。");
  }

  private async waitForForeground(
    adb: string,
    serial: string,
    userId: number,
    packageName: string,
    startAgain: () => Promise<void>,
    progress: Progress,
  ): Promise<void> {
    const homeOutput = await this.run(adb, [
      "-s", serial, "shell", "cmd", "package", "resolve-activity", "--brief",
      "--user", String(userId), "-a", "android.intent.action.MAIN", "-c", "android.intent.category.HOME",
    ], 3000).catch(() => "");
    this.assertActive();
    const home = homeOutput.split(/\r?\n/).map((line) => line.trim()).find((line) => COMPONENT_PATTERN.test(line));
    const normalize = (component: string) => {
      const [pkg, name] = component.split("/");
      return `${pkg}/${name.startsWith(".") ? pkg + name : name}`;
    };
    let stable = 0;
    let homeSince: number | undefined;
    let retried = false;
    let mayRetryHome = true;
    let lastForeground: ReturnType<typeof parseForegroundActivity>;
    let lastLocked: boolean | undefined;
    let diagnostic = "";
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const output = await this.run(adb, ["-s", serial, "shell", "dumpsys", "activity", "activities"], 3000)
        .catch((error) => { diagnostic = messageOf(error).slice(-1000); return ""; });
      this.assertActive();
      lastForeground = parseForegroundActivity(output, userId);
      lastLocked = parseKeyguardLocked(output);
      if (lastForeground?.packageName === packageName && lastLocked === false) {
        stable += 1;
        if (stable >= 2) return;
      } else stable = 0;

      const isHome = Boolean(home && !home.startsWith("android/") && lastForeground && normalize(home) === normalize(lastForeground.component));
      if (!lastForeground || lastLocked !== false || (!isHome && lastForeground.packageName !== packageName))
        mayRetryHome = false;
      if (isHome && lastLocked === false) {
        homeSince ??= Date.now();
        if (!retried && mayRetryHome && Date.now() - homeSince >= 2000) {
          retried = true;
          progress("模拟器仍显示系统桌面，正在重新打开应用…");
          this.assertActive();
          if (await this.currentUser(adb, serial) !== userId)
            throw new Error("模拟器当前用户已切换，请重新打开应用。");
          await startAgain();
          this.assertActive();
        }
      } else homeSince = undefined;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
      this.assertActive();
    }
    if (lastLocked)
      throw new Error("应用尚未显示在前台，请在模拟器窗口完成解锁后重试。");
    if (lastForeground && /^(?:com\.android\.permissioncontroller|com\.google\.android\.permissioncontroller|com\.android\.packageinstaller)$/.test(lastForeground.packageName))
      throw new Error("模拟器正在显示系统授权界面，请在窗口完成授权或取消后重新打开应用。");
    throw new Error([
      "未确认应用显示在前台。请查看模拟器窗口；若仍只有系统桌面，可在应用卡片的更多操作中选择“重新安装（保留数据）”。",
      lastForeground && `当前界面：${lastForeground.component}`,
      diagnostic,
    ].filter(Boolean).join("\n"));
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
    const scrcpy = this.nativeDisplay ? "" : await this.scrcpyPath(settings);
    if (!this.nativeDisplay && !scrcpy)
      throw new Error(
        this.privateAvdHome
          ? "内置显示组件缺失，请重新准备运行环境。"
          : "未找到 scrcpy。请先安装 scrcpy，并在运行环境中设置可执行文件路径。",
      );
    const { adb, serial, avd } = await this.ensureDevice(
      settings,
      mode,
      onProgress,
      this.nativeDisplay,
    );
    const nativeSession = this.ownedEmulators.get(avd);
    const userId = await this.currentUser(adb, serial);
    // Wake only the selected emulator. This cannot unlock a PIN-protected screen.
    await this.run(adb, [
      "-s",
      serial,
      "shell",
      "input",
      "keyevent",
      "KEYCODE_WAKEUP",
    ]).catch(() => undefined);
    this.assertActive();
    await this.run(adb, [
      "-s",
      serial,
      "shell",
      "wm",
      "dismiss-keyguard",
    ]).catch(() => undefined);
    this.assertActive();
    await this.waitForUnlockedUser(adb, serial, userId);
    await this.assertPackagePresent(adb, serial, userId, app.packageName);
    let category =
      mode === "tv"
        ? "android.intent.category.LEANBACK_LAUNCHER"
        : "android.intent.category.LAUNCHER";
    const resolutionDiagnostics: string[] = [];
    const resolveActivity = async (launcherCategory: string) => {
      const intent = [
        "--user", String(userId), "-a", "android.intent.action.MAIN",
        "-c", launcherCategory, "-p", app.packageName,
      ];
      const resolvedOutput = await this.run(adb, [
        "-s", serial, "shell", "cmd", "package", "resolve-activity", "--brief", ...intent,
      ]);
      this.assertActive();
      const resolved = parseResolvedActivity(resolvedOutput, app.packageName);
      if (resolved) return resolved;
      // Multiple enabled launcher activities can resolve to Android's chooser.
      // Select only components returned for this user/category by PackageManager;
      // metadata only ranks those candidates; am start enforces exported/permissions.
      const candidatesOutput = await this.run(adb, [
        "-s", serial, "shell", "cmd", "package", "query-activities", "--components", ...intent,
      ]);
      this.assertActive();
      resolutionDiagnostics.push(`${launcherCategory}:\nresolve: ${resolvedOutput.trim().slice(-600) || "（空）"}\nquery: ${candidatesOutput.trim().slice(-600) || "（空）"}`);
      const candidates = candidatesOutput.split(/\r?\n/)
        .map((line) => parseResolvedActivity(line, app.packageName))
        .filter((component): component is string => Boolean(component));
      const preferred = launcherCategory === "android.intent.category.LEANBACK_LAUNCHER" ? app.tvActivity : app.launchableActivity;
      return candidates.find((component) => {
        const name = component.split("/")[1];
        return (name.startsWith(".") ? app.packageName + name : name) === preferred;
      }) || candidates.sort()[0];
    };
    onProgress(`正在打开 ${app.name}…`);
    let activity = await resolveActivity(category);
    if (!activity && mode === "tv") {
      onProgress(
        "应用没有电视启动入口，将在电视设备中使用普通启动入口；遥控器兼容性取决于应用。",
      );
      category = "android.intent.category.LAUNCHER";
      activity = await resolveActivity(category);
    }
    if (!activity)
      throw new Error(
        [
          "应用已安装，但当前 Android 用户未找到可用启动入口。请在应用卡片的更多操作中选择“重新安装（保留数据）”后重试。",
          `包名：${app.packageName}；Android 用户：${userId}（RUNNING_UNLOCKED）`,
          ...resolutionDiagnostics,
        ].join("\n"),
      );
    // adb shell joins arguments; quote the validated component to preserve Java inner-class '$'.
    const startActivity = async () => {
      const output = await this.run(adb, [
        "-s", serial, "shell", "am", "start", "-W", "--user", String(userId),
        "-a", "android.intent.action.MAIN", "-c", category,
        "-f", "0x10200000", "-n", `'${activity}'`,
      ], 45_000);
      this.assertActive();
      const launchStatus = output.match(/^Status:\s*(\S+)/im)?.[1];
      if (/^(?:Error|Exception)|Error type \d|Permission Denial|SecurityException/im.test(output) || launchStatus?.toLowerCase() !== "ok")
        throw new Error(`启动应用失败：${output.trim() || "Android 未返回可确认的启动状态。"}`);
    };
    await startActivity();
    if (this.nativeDisplay) {
      if (nativeSession && childHasExited(nativeSession.child)) {
        throw new Error("模拟器窗口已关闭，请重新打开应用。");
      }
      await this.waitForForeground(adb, serial, userId, app.packageName, startActivity, onProgress);
      this.assertActive();
      if (nativeSession && childHasExited(nativeSession.child))
        throw new Error("模拟器窗口已关闭，请重新打开应用。");
      onProgress(`${app.name} 已在模拟器原生窗口打开。`);
      return;
    }
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
    const child = spawn(display.file, display.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...this.environment, ADB: adb },
    });
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
        if (!settled && hasVideoTexture(diagnostics)) {
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
    await this.waitForForeground(adb, serial, userId, app.packageName, startActivity, onProgress);
    this.assertActive();
    if (childHasExited(child)) throw new Error("应用显示窗口已关闭，请重新打开应用。");
    onProgress(`${app.name} 已在独立窗口打开。`);
  }

  private async clipboardCredentials(
    owned: OwnedEmulator,
  ): Promise<{ port: number; token: string }> {
    const invalid = () =>
      new Error("无法验证模拟器文本输入连接，请关闭并重新打开该模拟器后重试。");
    try {
      const discovery = await this.run(
        owned.adb,
        ["-s", owned.serial, "emu", "avd", "discoverypath"],
        5000,
      );
      const lines = discovery.split(/\r?\n/).filter((line) => line.length > 0);
      if (lines.length !== 2 || lines[1] !== "OK" || !isAbsolute(lines[0]))
        throw invalid();
      const pid = basename(lines[0]).match(/^pid_(\d+)\.ini$/)?.[1];
      // POSIX exec retains the PID; Windows emulator.exe spawns a QEMU child.
      // Windows ownership is pinned by the live launcher, exact serial, private
      // gRPC port and canonical AVD content directory instead of launcher PID.
      if (
        !pid ||
        (process.platform !== "win32" && Number(pid) !== owned.child.pid)
      )
        throw invalid();
      const info = await lstat(lines[0]);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
        throw invalid();
      const contents = await readFile(lines[0], "utf8");
      if (Buffer.byteLength(contents, "utf8") > 64 * 1024) throw invalid();
      const values = new Map<string, string>();
      for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^([^#;=]+)=(.*)$/);
        if (!match) continue;
        const key = match[1].trim();
        if (values.has(key)) throw invalid();
        values.set(key, match[2].trim());
      }
      if (
        !owned.grpcPort ||
        !owned.avdDirectory ||
        values.get("grpc.port") !== String(owned.grpcPort) ||
        values.get("port.serial") !== owned.serial.replace("emulator-", "") ||
        values.get("avd.id") !== owned.avd ||
        !values.get("grpc.token") ||
        !values.get("avd.dir") ||
        !isAbsolute(values.get("avd.dir")!)
      )
        throw invalid();
      const expected = await realpath(owned.avdDirectory);
      const actual = await realpath(values.get("avd.dir")!);
      if (
        process.platform === "win32"
          ? expected.toLowerCase() !== actual.toLowerCase()
          : expected !== actual
      )
        throw invalid();
      return { port: owned.grpcPort, token: values.get("grpc.token")! };
    } catch {
      // Neither discovery contents nor transport credentials belong in UI/logs.
      throw invalid();
    }
  }

  async sendText(
    mode: DeviceMode,
    text: string,
    settings: Settings,
  ): Promise<void> {
    this.assertActive();
    if (mode !== "phone" && mode !== "tv") throw new Error("无效的设备模式。");
    validateClipboardText(text);
    if (this.textSending) throw new Error("上一段文本仍在发送，请稍后重试。");
    const avd = configuredAvd(settings, mode, this.privateAvdHome);
    const owned = this.ownedEmulators.get(avd);
    if (
      !this.nativeDisplay ||
      !owned?.nativeWindow ||
      !owned.grpcPort ||
      childHasExited(owned.child)
    ) {
      throw new Error(
        `请先打开本应用的${mode === "phone" ? "手机" : "电视"}模拟器窗口，再发送文本。`,
      );
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.clipboardRequests.add(controller);
    this.textSending = true;
    owned.child.once("exit", abort);
    owned.child.once("error", abort);
    const assertTarget = () => {
      this.assertActive();
      if (
        controller.signal.aborted ||
        this.ownedEmulators.get(avd) !== owned ||
        childHasExited(owned.child)
      ) {
        throw new Error("模拟器窗口已关闭，文本发送已取消。");
      }
    };
    const verifyOnline = async () => {
      assertTarget();
      const devices = await this.devices(owned.adb);
      assertTarget();
      if (
        !devices.some(
          (device) =>
            device.serial === owned.serial &&
            device.avd === avd &&
            device.state === "device",
        )
      ) {
        throw new Error("目标模拟器未连接，文本未发送，请重新打开窗口后重试。");
      }
    };
    try {
      await verifyOnline();
      const credentials = await this.clipboardCredentials(owned);
      assertTarget();
      await setEmulatorClipboard(
        credentials.port,
        credentials.token,
        text,
        controller.signal,
      );
      assertTarget();
      // Readback confirms only the host clipboard cache, not delivery to Android.
      // Revalidate ownership/online state and paste once; never retry a paste or
      // send Enter. The UI reports 'sent', and integration tests verify guest input.
      await verifyOnline();
      assertTarget();
      await this.run(
        owned.adb,
        ["-s", owned.serial, "shell", "input", "keyevent", "KEYCODE_PASTE"],
        5000,
      ).catch(() => {
        throw new Error("文本发送失败，请确认模拟器输入框已聚焦后重试。");
      });
    } finally {
      owned.child.removeListener("exit", abort);
      owned.child.removeListener("error", abort);
      this.clipboardRequests.delete(controller);
      this.textSending = false;
    }
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

  private stopEmulator(owned: OwnedEmulator): Promise<void> {
    const stopping = this.stopEmulatorProcess(owned);
    this.stoppingEmulators.add(stopping);
    void stopping.then(
      () => this.stoppingEmulators.delete(stopping),
      () => this.stoppingEmulators.delete(stopping),
    );
    return stopping;
  }

  private async stopEmulatorProcess(owned: OwnedEmulator): Promise<void> {
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
    if (gracefulShutdown && (await waitForChildExit(owned.child, 15_000)))
      return;
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
    for (const request of this.clipboardRequests) request.abort();
    this.clipboardRequests.clear();
    for (const child of this.windows.values()) child.kill();
    this.windows.clear();
    const owned = [...this.ownedEmulators.values()];
    this.ownedEmulators.clear();
    const shutdowns = new Set([
      ...this.stoppingEmulators,
      ...owned.map((emulator) => this.stopEmulator(emulator)),
    ]);
    this.disposal = Promise.allSettled(shutdowns).then(async (results) => {
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
