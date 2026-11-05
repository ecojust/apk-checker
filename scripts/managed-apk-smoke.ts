import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AndroidRuntime } from "../electron/android";
import { AppLibrary } from "../electron/library";
import {
  ManagedRuntime,
  type RuntimeCatalog,
} from "../electron/managed-runtime";
import type { DeviceMode, LibraryApp, Settings } from "../src/shared/types";
import { captureNativeHost, probeProtectedLogin } from "./login-smoke";

// Opt-in integration test: fresh private SDK, AVD and adb server. No SDK Manager,
// host adb, pre-created emulator, fake process or rebuilt third-party APK is used.
const mode = process.env.APK_TEST_MODE || "phone";
const artifacts = path.resolve(
  process.env.APK_TEST_ARTIFACTS || `artifacts/managed-apk-${mode}`,
);
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA || null,
  mode,
  status: "running",
  steps: [],
  runtimeErrors: [],
  source: "https://gitee.com/yangyachao-X/maidong-ktv/releases/tag/2.1.8",
  scope:
    "Fresh managed-runtime preparation; embedded APK import; actual automatic boot, install, native emulator window, foreground/process survival, D-pad key injection and uninstall. No focus movement assertion, media playback, recording, audio latency or target macOS/Windows validation.",
};
let root: string | undefined;
let manager: ManagedRuntime | undefined;
let runtime: AndroidRuntime | undefined;
let library: AppLibrary | undefined;
let item: LibraryApp | undefined;
let settings: Settings | undefined;
let installed = false;
let serial: string | undefined;
let adb = "";
let environment: NodeJS.ProcessEnv = { ...process.env };
const runtimeErrors: string[] = report.runtimeErrors as string[];

function fail(error: unknown, title = "Managed APK smoke test"): void {
  const message = error instanceof Error ? error.message : String(error);
  report.status = "failed";
  (report.errors as string[] | undefined)?.push(message);
  if (!report.errors) report.errors = [message];
  process.exitCode = 1;
  console.error(message);
  if (process.env.GITHUB_ACTIONS)
    console.log(
      `::error title=${title}::${message.slice(-8000).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
    );
}

async function step<T>(name: string, action: () => Promise<T>): Promise<T> {
  console.log(`STEP: ${name}`);
  const started = Date.now();
  try {
    const detail = await action();
    (report.steps as unknown[]).push({
      name,
      status: "passed",
      durationMs: Date.now() - started,
      detail,
    });
    return detail;
  } catch (error) {
    (report.steps as unknown[]).push({
      name,
      status: "failed",
      durationMs: Date.now() - started,
      error: String(error),
    });
    throw error;
  }
}

function command(
  file: string,
  args: string[],
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        env: environment,
        encoding: "utf8",
        timeout,
        maxBuffer: 16 * 1024 ** 2,
      },
      (error, stdout, stderr) => {
        if (error)
          reject(
            new Error(
              `${path.basename(file)}: ${String(stderr || stdout || error.message).trim()}`,
            ),
          );
        else resolve(stdout);
      },
    );
  });
}

function shell(...args: string[]): Promise<string> {
  assert(serial, "Managed emulator has no serial");
  return command(adb, ["-s", serial, "shell", ...args]);
}

async function discoverDevice(): Promise<void> {
  if (!runtime || !settings) return;
  const status = await runtime.getStatus(settings);
  report.runtime = status;
  const name = mode === "phone" ? settings.phoneAvd : settings.tvAvd;
  serial = status.devices.find(
    (device) => device.avd === name && device.state === "device",
  )?.serial;
}

async function screenshot(file: string): Promise<void> {
  if (!serial) return;
  const png = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      adb,
      ["-s", serial!, "exec-out", "screencap", "-p"],
      {
        env: environment,
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: 16 * 1024 ** 2,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  assert(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "screencap did not return PNG",
  );
  await writeFile(path.join(artifacts, file), png);
}

async function foreground(): Promise<unknown> {
  assert(item);
  const pid = (await shell("pidof", item.packageName)).trim();
  assert(/^\d+(?:\s+\d+)*$/.test(pid), "APK process is not running");
  const activities = await shell("dumpsys", "activity", "activities");
  await writeFile(path.join(artifacts, "activities.txt"), activities);
  const resumed = activities
    .split(/\r?\n/)
    .filter((line) => /(?:mResumedActivity|topResumedActivity)/.test(line));
  assert(
    resumed.some((line) => line.includes(`${item!.packageName}/`)),
    `APK is not foreground: ${resumed.join("; ")}`,
  );
  assert.equal(
    runtimeErrors.length,
    0,
    "The runtime reported an asynchronous failure",
  );
  return { pid, resumedActivities: resumed };
}

async function privateRuntimeProcesses(): Promise<string[]> {
  if (process.platform !== "linux" || !root) return [];
  const output = await command("ps", ["-eo", "pid=,ppid=,args="]);
  return output
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes(root + path.sep) &&
        /(?:sdk\/emulator|platform-tools|scrcpy)/.test(line),
    );
}

async function hostDiagnostics(): Promise<void> {
  if (process.platform !== "linux" || !root) return;
  const results = await Promise.allSettled([
    command("free", ["-h"]),
    command("df", ["-h", root]),
    command("sudo", ["-n", "dmesg", "--color=never"]),
  ]);
  const output = results
    .map((result, index) => {
      let contents =
        result.status === "fulfilled" ? result.value : String(result.reason);
      if (index === 2 && result.status === "fulfilled")
        contents = contents
          .split(/\r?\n/)
          .filter((line) => /oom|out of memory|killed process|qemu/i.test(line))
          .slice(-100)
          .join("\n");
      return (
        ["Memory", "Disk", "Kernel OOM/QEMU diagnostics"][index] +
        "\n" +
        contents
      );
    })
    .join("\n\n");
  await writeFile(path.join(artifacts, "host-diagnostics.txt"), output);
  report.privateProcessesBeforeShutdown = await privateRuntimeProcesses();
}

async function run(): Promise<void> {
  await mkdir(artifacts, { recursive: true });
  try {
    assert(
      mode === "phone" || mode === "tv",
      "APK_TEST_MODE must be phone or tv",
    );
    const deviceMode: DeviceMode = mode;
    const apk = process.env.APK_PATH;
    assert(apk, "Set APK_PATH to the original release APK");
    const expectedHash =
      "86ef92ec8b1ac277eb68f28f3ff4fb421f7bc2a1e6093229a706d3aaa0310a3b";
    await step("Verify fixed original APK checksum", async () => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(apk)) hash.update(chunk);
      const actual = hash.digest("hex");
      assert.equal(actual, expectedHash);
      report.sha256 = actual;
      return actual;
    });

    const resources = path.resolve(
      process.env.MANAGED_RUNTIME_RESOURCES || "resources",
    );
    const catalog = JSON.parse(
      await readFile(path.join(resources, "runtime-catalog.json"), "utf8"),
    ) as RuntimeCatalog;
    const definition = catalog.platforms[`${process.platform}-${process.arch}`];
    assert(definition, "Host platform is absent from the real runtime catalog");
    report.systemImage = definition.images[deviceMode];
    await step("Verify installer-provided core archives exist", async () => {
      const bundled = definition.components.filter(
        (component) => "bundle" in component && component.bundle === true,
      );
      assert(bundled.length > 0, "Catalog has no bundled core");
      for (const component of bundled) {
        assert(component.bundledFile);
        const file = path.join(
          resources,
          "runtime-bundled",
          component.bundledFile,
        );
        assert.equal(
          (await stat(file)).size,
          component.size,
          `Run npm run runtime:prepare first: ${component.id}`,
        );
      }
      return bundled.map(({ id, size, checksum }) => ({ id, size, checksum }));
    });
    root = await mkdtemp(path.join(tmpdir(), "apk-checker-managed-smoke-"));
    manager = new ManagedRuntime(root, resources);
    await manager.init();
    const overrides = manager.getEnvironment();
    environment = { ...process.env, ...overrides };
    report.managedEnvironment = overrides;
    assert.equal(
      overrides.APK_CHECKER_DISPLAY_MODE,
      "native",
      "Managed smoke must exercise the actual native-display configuration",
    );
    assert(
      overrides.ADB_SERVER_SOCKET &&
        !overrides.ADB_SERVER_SOCKET.endsWith(":5037"),
      "Test must use its own adb server",
    );
    runtime = new AndroidRuntime((message) => {
      runtimeErrors.push(message);
      console.error(message);
    }, overrides);
    library = new AppLibrary(path.join(root, "library"));
    await library.init();
    await step(
      "Import APK with embedded parser before runtime preparation",
      async () => {
        const result = await library!.importApk(apk);
        item = result.app;
        assert.equal(item.packageName, "com.local.ktv");
        assert.equal(item.versionName, "2.1.8");
        assert.equal(item.versionCode, "11");
        assert.equal(result.duplicate, false);
        assert.deepEqual(item.installed, {});
        assert((await library!.importApk(apk)).duplicate);
        await writeFile(
          path.join(artifacts, "apk-metadata.json"),
          JSON.stringify(item, null, 2),
        );
        return item;
      },
    );
    await step(
      "Record first-use license and prepare managed engine/image/AVD",
      async () => {
        const before = await manager!.getStatus();
        assert.equal(before.licenseAccepted, false);
        assert.equal(before.phoneReady, false);
        assert.equal(before.tvReady, false);
        const license = await manager!.getLicense();
        report.licenseSha256 = createHash("sha256")
          .update(license)
          .digest("hex");
        await manager!.acceptLicense();
        let lastMessage = "";
        let lastLogged = 0;
        settings = await manager!.prepare(
          deviceMode,
          (message, completedBytes, totalBytes) => {
            report.preparationProgress = {
              message,
              completedBytes,
              totalBytes,
            };
            if (message !== lastMessage || Date.now() - lastLogged >= 10_000) {
              console.log(
                `PREPARE: ${message} ${completedBytes ?? ""}/${totalBytes ?? ""}`,
              );
              lastMessage = message;
              lastLogged = Date.now();
            }
          },
        );
        const after = await manager!.getStatus();
        assert.equal(after.coreReady, true);
        assert.equal(
          deviceMode === "phone" ? after.phoneReady : after.tvReady,
          true,
        );
        const name =
          deviceMode === "phone" ? settings.phoneAvd : settings.tvAvd;
        const config = await readFile(
          path.join(overrides.ANDROID_AVD_HOME!, `${name}.avd`, "config.ini"),
          "utf8",
        );
        await writeFile(path.join(artifacts, "managed-avd-config.ini"), config);
        report.settings = settings;
        adb = path.join(
          settings.sdkPath,
          "platform-tools",
          process.platform === "win32" ? "adb.exe" : "adb",
        );
        await library!.saveSettings(settings);
        report.scrcpyVersion = await command(settings.scrcpyPath, [
          "--version",
        ]);
        return { before, after, generatedAvd: name };
      },
    );
    assert(settings && item);
    await step(
      "Automatically boot private AVD and install APK through AndroidRuntime",
      async () => {
        // userData and this AVD were created by mkdtemp above: there is no existing
        // user package or data to overwrite. Installation must create its own device.
        const before = await runtime!.getStatus(settings!);
        assert.equal(
          before.devices.length,
          0,
          "Fresh private adb unexpectedly sees an existing device",
        );
        const result = await runtime!.install(
          item!,
          library!.getApkPath(item!.id),
          deviceMode,
          settings!,
          console.log,
        );
        installed = true;
        await library!.markInstalled(item!.id, deviceMode, result.avd);
        item = library!.getApp(item!.id);
        await discoverDevice();
        assert(
          serial,
          "Installed AVD was not visible to its private adb server",
        );
        const packages = await shell(
          "pm",
          "list",
          "packages",
          item.packageName,
        );
        assert(packages.split(/\r?\n/).includes(`package:${item.packageName}`));
        const reopened = new AppLibrary(path.join(root!, "library"));
        await reopened.init();
        assert.equal(
          reopened.getApp(item.id).installed[deviceMode]?.avd,
          result.avd,
        );
        return { avd: result.avd, serial, desktopMarkerPersisted: true };
      },
    );
    const properties: Record<string, string> = {};
    for (const property of [
      "ro.build.version.sdk",
      "ro.build.fingerprint",
      "ro.product.cpu.abilist",
      "ro.dalvik.vm.native.bridge",
      "ro.build.characteristics",
    ])
      properties[property] = (await shell("getprop", property)).trim();
    report.deviceProperties = properties;
    await command(adb, ["-s", serial!, "logcat", "-c"]);
    await step(
      "Grant declared storage permissions for unattended startup",
      async () => {
        const permissions = [
          "android.permission.READ_EXTERNAL_STORAGE",
          "android.permission.WRITE_EXTERNAL_STORAGE",
        ];
        for (const permission of permissions)
          await shell("pm", "grant", item!.packageName, permission);
        return { granted: permissions, microphonePermissionGranted: false };
      },
    );
    await step(
      "Launch APK in native emulator primary-display window",
      async () => {
        await runtime!.launch(item!, deviceMode, settings!, console.log);
        // Native mode may restart the owned headless AVD on another console port.
        await discoverDevice();
        assert(serial, "Native AVD was not rediscovered after launch");
        const windowType = await command(adb, [
          "-s",
          serial,
          "emu",
          "avd",
          "windowtype",
        ]);
        assert(
          windowType
            .split(/\r?\n/)
            .some((line) => line.trim() === "windowtype=qtwindow"),
          `Expected primary Qt display, got: ${windowType}`,
        );
        await new Promise((resolve) => setTimeout(resolve, 5000));
        await screenshot("01-startup.png");
        const host = await captureNativeHost(
          {
            artifacts,
            avd: deviceMode === "phone" ? settings!.phoneAvd : settings!.tvAvd,
            shell,
            command,
            screenshot,
          },
          "01-native-startup",
        );
        report.nativeDisplay = {
          windowType: "qtwindow",
          hostWindow: host.window,
          capturedAt: host.capturedAt,
        };
        return {
          nativeDisplay: report.nativeDisplay,
          foreground: await foreground(),
        };
      },
    );
    if (process.env.APK_LOGIN_PROBE === "1") {
      report.loginProbe = await step(
        "Verify protected empty login form in native display without credentials",
        () =>
          probeProtectedLogin({
            artifacts,
            avd: deviceMode === "phone" ? settings!.phoneAvd : settings!.tvAvd,
            shell,
            command,
            screenshot,
          }),
      );
    }
    await step(
      "Inject direction keys and verify APK survives in foreground",
      async () => {
        const keys = [
          "KEYCODE_DPAD_RIGHT",
          "KEYCODE_DPAD_DOWN",
          "KEYCODE_DPAD_LEFT",
          "KEYCODE_DPAD_UP",
        ];
        for (const key of keys) {
          await shell("input", "keyevent", key);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await screenshot("02-after-dpad.png");
        return {
          injectedKeys: keys,
          foreground: await foreground(),
          focusMovementVerified: false,
        };
      },
    );
    report.status = "passed";
  } catch (error) {
    fail(error);
  } finally {
    await discoverDevice().catch((error) => {
      report.deviceDiscoveryError = String(error);
    });
    if (serial) {
      await screenshot("03-final-state.png").catch((error) => {
        report.screenshotError = String(error);
      });
      const logcat = await command(adb, [
        "-s",
        serial,
        "logcat",
        "-d",
        "-v",
        "threadtime",
        "-t",
        "2500",
      ]).catch(String);
      await writeFile(path.join(artifacts, "logcat.txt"), logcat);
    }
    if (installed && runtime && library && item && settings) {
      try {
        await step("Uninstall test APK and clear desktop marker", async () => {
          await runtime!.uninstall(
            item!,
            mode as DeviceMode,
            settings!,
            console.log,
          );
          // A failed native launch may have stopped the old device; uninstall
          // can boot the same private AVD again on a different serial.
          await discoverDevice();
          assert(
            serial,
            "Uninstalled private AVD was not rediscovered for verification",
          );
          await library!.markUninstalled(item!.id, mode as DeviceMode);
          assert.equal(
            library!.getApp(item!.id).installed[mode as DeviceMode],
            undefined,
          );
          const packages = await shell(
            "pm",
            "list",
            "packages",
            item!.packageName,
          );
          assert(
            !packages.split(/\r?\n/).includes(`package:${item!.packageName}`),
          );
          return { packageRemoved: true, markerCleared: true };
        });
      } catch (error) {
        fail(error, "Managed APK cleanup");
      }
    }
    await hostDiagnostics().catch((error) => {
      report.hostDiagnosticsError = String(error);
    });
    let shutdownConfirmed = true;
    await runtime?.dispose().catch((error) => {
      shutdownConfirmed = false;
      fail(error, "Managed runtime shutdown");
    });
    await manager?.dispose().catch((error) => {
      shutdownConfirmed = false;
      fail(error, "Managed preparation shutdown");
    });
    if (runtimeErrors.length)
      fail(runtimeErrors.join("\n"), "Managed runtime asynchronous failure");
    try {
      let remaining = await privateRuntimeProcesses();
      report.privateProcessesImmediatelyAfterShutdown = remaining;
      const watchdogStarted = Date.now();
      // Android Emulator starts this 20-second kill watchdog during its normal
      // shutdown. QEMU and all data-writing/display processes must already be
      // gone; allow only this exact helper to exit naturally before deleting data.
      while (
        remaining.length > 0 &&
        remaining.every((line) =>
          /\/sdk\/emulator\/emulator\s+-kill\s+\d+\s+-sleep\s+20\s*$/.test(
            line,
          ),
        ) &&
        Date.now() - watchdogStarted < 25_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        remaining = await privateRuntimeProcesses();
      }
      report.privateShutdownWatchdogWaitMs = Date.now() - watchdogStarted;
      report.privateProcessesAfterShutdown = remaining;
      assert.equal(
        remaining.length,
        0,
        `dispose returned with private Android processes still alive: ${remaining.join("; ")}`,
      );
    } catch (error) {
      shutdownConfirmed = false;
      fail(error, "Private runtime process cleanup");
    }
    if (root && !shutdownConfirmed) report.retainedPrivateDataPath = root;
    if (root && shutdownConfirmed)
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 1000,
      }).catch((error) => fail(error, "Private test data cleanup"));
    report.completedAt = new Date().toISOString();
    await writeFile(
      path.join(artifacts, "summary.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
    if (process.env.GITHUB_ACTIONS) {
      // Keep concise evidence accessible through the checks API when artifact
      // blob downloads are unavailable to a reviewer. No environment secrets.
      const diagnostic = JSON.stringify({
        status: report.status,
        steps: (
          report.steps as { name: string; status: string; durationMs: number }[]
        ).map(({ name, status, durationMs }) => ({ name, status, durationMs })),
        runtime: report.runtime,
        deviceProperties: report.deviceProperties,
        nativeDisplay: report.nativeDisplay,
        loginProbe: report.loginProbe,
        preparationProgress: report.preparationProgress,
        privateProcessesBeforeShutdown: report.privateProcessesBeforeShutdown,
        privateProcessesImmediatelyAfterShutdown:
          report.privateProcessesImmediatelyAfterShutdown,
        privateShutdownWatchdogWaitMs: report.privateShutdownWatchdogWaitMs,
        privateProcessesAfterShutdown: report.privateProcessesAfterShutdown,
        retainedPrivateDataPath: report.retainedPrivateDataPath,
      })
        .slice(0, 8000)
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      console.log(`::notice title=Managed ${mode} test stages::${diagnostic}`);
    }
  }
}
void run().catch((error) => {
  fail(error);
});
