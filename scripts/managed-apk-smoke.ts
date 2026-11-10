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
import { captureNativeHost, probeProtectedLogin, publishProbeDiagnostic } from "./login-smoke";
import { probeHostKeyboard } from "./keyboard-smoke";
import fixtures from "./managed-apk-fixtures.json";

// Opt-in integration test: fresh private SDK, AVD and adb server. No SDK Manager,
// host adb, pre-created emulator, fake process or rebuilt third-party APK is used.
const mode = process.env.APK_TEST_MODE || "phone";
const application = process.env.APK_TEST_APPLICATION || "maidong";
const fixture = Object.hasOwn(fixtures, application)
  ? fixtures[application as keyof typeof fixtures]
  : undefined;
const keyboardProbeEnabled = Boolean(fixture?.maidongProbes && process.env.APK_KEYBOARD_PROBE === "1");
const loginProbeEnabled = Boolean(fixture?.maidongProbes && process.env.APK_LOGIN_PROBE === "1");
const artifacts = path.resolve(
  process.env.APK_TEST_ARTIFACTS || `artifacts/managed-apk-${mode}`,
);
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  commit: process.env.GITHUB_SHA || null,
  mode,
  application,
  status: "running",
  steps: [],
  runtimeErrors: [],
  source: fixture?.source,
  referenceNote: fixture?.referenceNote,
  optionalProbes: {
    keyboard: keyboardProbeEnabled ? "requested" : fixture?.maidongProbes ? "not-requested" : "not-applicable",
    login: loginProbeEnabled ? "requested" : fixture?.maidongProbes ? "not-requested" : "not-applicable",
  },
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
  const capture = await new Promise<{
    error: Error | null;
    stdout: Buffer;
    stderr: Buffer;
  }>((resolve) => {
    execFile(
      adb,
      ["-s", serial!, "exec-out", "screencap", "-p"],
      {
        env: environment,
        encoding: "buffer",
        timeout: 30_000,
        maxBuffer: 16 * 1024 ** 2,
      },
      (error, stdout, stderr) => resolve({ error, stdout, stderr }),
    );
  });
  const png = capture.stdout;
  if (
    capture.error ||
    !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    const detail = JSON.stringify({
      error: capture.error?.message,
      stdoutBytes: png.length,
      stdout: png.toString("utf8", 0, 2000),
      stderr: capture.stderr.toString("utf8", 0, 4000),
    });
    await writeFile(path.join(artifacts, `${file}.error.json`), detail);
    throw new Error(`screencap did not return PNG: ${detail}`);
  }
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

async function captureLaunchDiagnostics(): Promise<void> {
  if (!serial || !settings || !item || !fixture) return;
  const targetSerial = serial;
  const avd = mode === "phone" ? settings.phoneAvd : settings.tvAvd;
  const diagnostics: Record<string, unknown> = {
    capturedAt: new Date().toISOString(), application,
    serial: targetSerial, avd, packageName: fixture.packageName,
  };
  const read = async (args: string[]) => {
    try { return { args, stdout: await command(adb, ["-s", targetSerial, ...args], 10_000) }; }
    catch (error) { return { args, error: String(error) }; }
  };
  try {
    // Reconfirm the current serial after headless/native restart. Never query a
    // recycled console port or a package outside this test's fixed fixture.
    const identity = await read(["emu", "avd", "name"]);
    diagnostics.identity = identity;
    assert(identity.stdout?.split(/\r?\n/).map((line) => line.trim()).includes(avd),
      "Private test AVD identity could not be reconfirmed; package diagnostics skipped");
    assert.equal(item.packageName, fixture.packageName);
    // Read the dedicated crash buffer before slower package/window diagnostics.
    // This is a fresh private AVD with a pinned APK and no user accounts.
    const crash = await read(["logcat", "-b", "crash", "-d", "-v", "threadtime", "-t", "500"]);
    if (crash.stdout !== undefined) {
      await writeFile(path.join(artifacts, "logcat-crash.txt"), crash.stdout);
      report.crashDiagnostics = { file: "logcat-crash.txt", text: crash.stdout.slice(-24_000),
        truncated: crash.stdout.length > 24_000, packageName: fixture.packageName };
    } else report.crashDiagnostics = crash;
    // Also capture ABI/API on failed installation, before normal post-install
    // recording can run. Do not infer device ABIs from the host architecture.
    if (!report.deviceProperties) {
      const properties: Record<string, unknown> = {};
      for (const property of ["ro.build.version.sdk", "ro.build.fingerprint",
        "ro.product.cpu.abilist", "ro.dalvik.vm.native.bridge", "ro.build.characteristics"])
        properties[property] = await read(["shell", "getprop", property]);
      report.failedInstallDeviceProperties = properties;
    }
    const currentUser = await read(["shell", "am", "get-current-user"]);
    diagnostics.currentUser = currentUser;
    const user = currentUser.stdout?.trim();
    assert(user && /^\d+$/.test(user), "Current Android user is unknown; user-scoped queries skipped");
    diagnostics.userUnlocked = await read(["shell", "cmd", "user", "is-user-unlocked", user]);
    diagnostics.userState = await read(["shell", "am", "get-started-user-state", user]);
    const packages = await read(["shell", "pm", "list", "packages", "--user", user, fixture.packageName]);
    diagnostics.packages = packages;
    diagnostics.exactPackagePresent = packages.stdout === undefined ? null
      : packages.stdout.split(/\r?\n/).includes(`package:${fixture.packageName}`);
    const launchers: Record<string, unknown> = {};
    for (const category of ["android.intent.category.LAUNCHER", "android.intent.category.LEANBACK_LAUNCHER"]) {
      const intent = ["--user", user, "-a", "android.intent.action.MAIN", "-c", category, "-p", fixture.packageName];
      launchers[category] = {
        resolved: await read(["shell", "cmd", "package", "resolve-activity", "--brief", ...intent]),
        queried: await read(["shell", "cmd", "package", "query-activities", "--brief", ...intent]),
      };
    }
    diagnostics.launchers = launchers;
    const activities = await read(["shell", "dumpsys", "activity", "activities"]);
    if (activities.stdout !== undefined) {
      await writeFile(path.join(artifacts, "launch-activities.txt"), activities.stdout);
      diagnostics.activityState = {
        file: "launch-activities.txt",
        lines: activities.stdout.split(/\r?\n/)
          .filter((line) => /Display #|topResumedActivity|mResumedActivity|keyguard/i.test(line))
          .slice(0, 60).map((line) => line.slice(0, 400)).join("\n"),
      };
    } else diagnostics.activityState = activities;
  } catch (error) {
    diagnostics.error = String(error);
  }
  await writeFile(path.join(artifacts, "launch-diagnostics.json"), JSON.stringify(diagnostics, null, 2));
  // The full raw responses remain in the small diagnostic artifact. Keep the
  // checks/log summary bounded when artifact storage is unavailable.
  report.launchDiagnostics = JSON.parse(JSON.stringify(diagnostics,
    (_key, value: unknown) => typeof value === "string" ? value.slice(0, 2000) : value));
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
    assert(fixture, `Unknown managed APK fixture: ${application}`);
    assert(
      mode === "phone" || mode === "tv",
      "APK_TEST_MODE must be phone or tv",
    );
    const deviceMode: DeviceMode = mode;
    const apk = process.env.APK_PATH;
    assert(apk, "Set APK_PATH to the original release APK");
    const expectedHash = fixture.sha256;
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
        assert.equal(item.packageName, fixture.packageName);
        assert.equal(item.versionName, fixture.versionName);
        assert.equal(item.versionCode, fixture.versionCode);
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
    if (fixture.unattendedPermissions.length) await step(
      "Grant declared storage permissions for unattended startup",
      async () => {
        const permissions = fixture.unattendedPermissions;
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
    if (keyboardProbeEnabled) {
      try {
        report.keyboardProbe = await step(
          "Verify host keyboard and managed text input in public search without Enter",
          () => probeHostKeyboard({
            artifacts,
            avd: deviceMode === "phone" ? settings!.phoneAvd : settings!.tvAvd,
            shell,
            command,
            screenshot,
            sendText: (text) => runtime!.sendText(deviceMode, text, settings!),
          }),
        );
      } catch (error) {
        fail(error, "Managed keyboard probe");
      }
    }
    if (loginProbeEnabled) {
      try {
        if (keyboardProbeEnabled)
          await step("Reset test APK activity between independent UI probes", async () => {
            const previousForeground = await foreground().catch(String);
            await shell("am", "force-stop", item!.packageName);
            await runtime!.launch(item!, deviceMode, settings!, console.log);
            await discoverDevice();
            assert(serial, "Private AVD was not rediscovered after test activity reset");
            await new Promise((resolve) => setTimeout(resolve, 1500));
            return { previousForeground, currentForeground: await foreground(),
              apkDataCleared: false, reason: "Reset only the fresh test APK activity before the independent login probe" };
          });
        report.loginProbe = await step(
          "Verify protected empty login form in native display without credentials",
          () => probeProtectedLogin({
            artifacts,
            avd: deviceMode === "phone" ? settings!.phoneAvd : settings!.tvAvd,
            shell,
            command,
            screenshot,
            rotateNativeDisplay: async () => {
              assert(serial, "Native rotation requires the current private AVD serial");
              await command(adb, ["-s", serial, "emu", "rotate"]);
            },
          }),
        );
      } catch (error) {
        fail(error, "Managed login probe");
      }
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
    if (report.status !== "failed") report.status = "passed";
  } catch (error) {
    fail(error);
  } finally {
    await discoverDevice().catch((error) => {
      report.deviceDiscoveryError = String(error);
    });
    await captureLaunchDiagnostics().catch((error) => {
      report.launchDiagnosticsError = String(error);
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
      const keyboard = report.keyboardProbe as Record<string, unknown> | undefined;
      const login = report.loginProbe as Record<string, unknown> | undefined;
      const diagnosticData = {
        status: report.status,
        application,
        source: fixture?.source,
        sha256: report.sha256,
        referenceNote: fixture?.referenceNote,
        optionalProbes: report.optionalProbes,
        launchDiagnostics: report.launchDiagnostics,
        steps: (
          report.steps as { name: string; status: string; durationMs: number }[]
        ).map(({ name, status, durationMs }) => ({ name: name.slice(0, 55), status, durationMs })),
        deviceProperties: report.deviceProperties,
        failedInstallDeviceProperties: report.failedInstallDeviceProperties,
        nativeDisplay: report.nativeDisplay,
        keyboardProbe: keyboard && { status: keyboard.status },
        loginProbe: login && { status: login.status,
          nativeEditTextCount: login.nativeEditTextCount,
          secureWindowCount: Array.isArray(login.secureWindows) ? login.secureWindows.length : 0,
          inputRegionPixels: login.inputRegionPixels,
          guestCapture: login.guestCapture && {
            status: (login.guestCapture as Record<string, unknown>).status,
            error: String((login.guestCapture as Record<string, unknown>).error ?? "").slice(0, 300),
            redactionVerified: (login.guestCapture as Record<string, unknown>).redactionVerified,
          },
          nativeRotationCount: Array.isArray(login.nativeDisplayRotations) ? login.nativeDisplayRotations.length : 0,
          nativeOrientation: login.nativeOrientation,
          dialogDismissed: login.dialogDismissed,
        },
        privateShutdownWatchdogWaitMs: report.privateShutdownWatchdogWaitMs,
        privateProcessesAfterShutdown: report.privateProcessesAfterShutdown,
        retainedPrivateDataPath: report.retainedPrivateDataPath,
        fullDiagnosticArtifact: "summary.json",
      };
      publishProbeDiagnostic(`Managed ${mode} test stages`, diagnosticData);
      if (report.crashDiagnostics) publishProbeDiagnostic(`Managed ${mode} crash buffer`, report.crashDiagnostics);
    }
  }
}
void run().catch((error) => {
  fail(error);
});
