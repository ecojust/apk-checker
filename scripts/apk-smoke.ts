import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AppLibrary } from "../electron/library";
import { AndroidRuntime } from "../electron/android";
import type { DeviceMode, LibraryApp, Settings } from "../src/shared/types";

// This is an opt-in, real-device test. It never substitutes a rebuilt APK or a
// fake Android process, and never copies the supplied APK into test artifacts.
type Step = { name: string; status: "passed" | "failed"; detail?: unknown };
const mode = process.env.APK_TEST_MODE === "tv" ? "tv" : "phone";
const artifactDirectory = path.resolve(
  process.env.APK_TEST_ARTIFACTS || `artifacts/apk-smoke-${mode}`,
);
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  mode,
  source: "https://gitee.com/yangyachao-X/maidong-ktv/releases/tag/2.1.8",
  commit: process.env.GITHUB_SHA || null,
  status: "running",
  scope:
    "APK import, real emulator install, scrcpy video window, foreground/process stability, D-pad navigation and uninstall. No song playback, audio latency or microphone test.",
  steps: [] as Step[],
  runtimeErrors: [] as string[],
};
const runtime = new AndroidRuntime((message) => {
  (report.runtimeErrors as string[]).push(message);
  console.error(message);
});
let library: AppLibrary | undefined;
let entry: LibraryApp | undefined;
let temporaryDirectory: string | undefined;
let serial: string | undefined;
let adb = "";
let installed = false;
let settings: Settings;
const progress = (message: string) => console.log(`[${mode}] ${message}`);

function command(
  file: string,
  args: string[],
  timeout = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout, maxBuffer: 16 * 1024 ** 2 },
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

async function step<T>(name: string, operation: () => Promise<T>): Promise<T> {
  console.log(`STEP: ${name}`);
  try {
    const result = await operation();
    (report.steps as Step[]).push({ name, status: "passed", detail: result });
    return result;
  } catch (error) {
    (report.steps as Step[]).push({
      name,
      status: "failed",
      detail: String(error),
    });
    throw error;
  }
}

async function adbShell(...args: string[]): Promise<string> {
  assert(serial, "A running emulator must be selected first");
  return command(adb, ["-s", serial, "shell", ...args]);
}

async function screenshot(name: string): Promise<void> {
  if (!serial) return;
  const png = await new Promise<Buffer>((resolve, reject) => {
    execFile(
      adb,
      ["-s", serial!, "exec-out", "screencap", "-p"],
      { timeout: 30_000, maxBuffer: 16 * 1024 ** 2, encoding: "buffer" },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
  assert(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    "screencap did not return a PNG",
  );
  await writeFile(path.join(artifactDirectory, name), png);
}

async function foreground(): Promise<{
  pid: string;
  resumedActivities: string[];
}> {
  assert(entry);
  const pid = (await adbShell("pidof", entry.packageName)).trim();
  assert(/^\d+(?:\s+\d+)*$/.test(pid), "APK process is not running");
  const activities = await adbShell("dumpsys", "activity", "activities");
  await writeFile(path.join(artifactDirectory, "activities.txt"), activities);
  const resumedActivities = activities
    .split(/\r?\n/)
    .filter((line) => /(?:mResumedActivity|topResumedActivity)/.test(line));
  assert(
    resumedActivities.some((line) => line.includes(`${entry!.packageName}/`)),
    `APK is not foreground: ${resumedActivities.join("; ")}`,
  );
  assert.equal(
    (report.runtimeErrors as string[]).length,
    0,
    "scrcpy exited abnormally",
  );
  return { pid, resumedActivities };
}

async function run(): Promise<void> {
  await mkdir(artifactDirectory, { recursive: true });
  try {
    const apkPath = process.env.APK_PATH;
    const expectedHash = process.env.EXPECTED_APK_SHA256;
    assert(apkPath, "Set APK_PATH to the actual downloaded release APK");
    assert(
      expectedHash && /^[a-f0-9]{64}$/.test(expectedHash),
      "Set EXPECTED_APK_SHA256 to a verified release checksum",
    );
    const sdkPath = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
    assert(sdkPath, "ANDROID_SDK_ROOT or ANDROID_HOME is required");
    const avd = process.env.APK_TEST_AVD || `apk_${mode}`;
    settings = {
      sdkPath,
      scrcpyPath: process.env.SCRCPY_PATH || "/usr/bin/scrcpy",
      phoneAvd: mode === "phone" ? avd : "",
      tvAvd: mode === "tv" ? avd : "",
      defaultMode: mode as DeviceMode,
    };
    adb = path.join(
      sdkPath,
      "platform-tools",
      process.platform === "win32" ? "adb.exe" : "adb",
    );
    await step("Verify original release SHA-256", async () => {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(apkPath)) hash.update(chunk);
      const actual = hash.digest("hex");
      assert.equal(
        actual,
        expectedHash,
        "Downloaded APK does not match verified release",
      );
      report.sha256 = actual;
      return actual;
    });

    const status = await runtime.getStatus(settings);
    report.runtime = status;
    serial = status.devices.find(
      (device) => device.avd === avd && device.state === "device",
    )?.serial;
    assert(serial, `Start the test AVD ${avd} before running the smoke test`);
    const properties: Record<string, string> = {};
    for (const property of [
      "ro.build.version.sdk",
      "ro.build.version.release",
      "ro.build.fingerprint",
      "ro.product.cpu.abilist",
      "ro.product.cpu.abilist32",
      "ro.product.cpu.abilist64",
      "ro.dalvik.vm.native.bridge",
      "ro.build.characteristics",
    ]) {
      properties[property] = (await adbShell("getprop", property)).trim();
    }
    report.device = {
      avd,
      serial,
      properties,
      expectedImage: process.env.APK_TEST_SYSTEM_IMAGE || null,
    };
    await command(adb, ["-s", serial, "logcat", "-c"]);
    const aapt = await runtime.getAaptPath(settings);
    const badging = await command(aapt, ["dump", "badging", apkPath]);
    await writeFile(path.join(artifactDirectory, "badging.txt"), badging);
    report.nativeCode =
      badging.split(/\r?\n/).find((line) => line.startsWith("native-code:")) ||
      "No native ABI restriction reported";
    report.aapt = aapt;
    report.scrcpyVersion = await command(settings.scrcpyPath, ["--version"]);

    temporaryDirectory = await mkdtemp(
      path.join(tmpdir(), "apk-checker-real-smoke-"),
    );
    library = new AppLibrary(temporaryDirectory);
    await library.init();
    await library.saveSettings(settings);
    entry = await step(
      "Import release APK using AppLibrary and aapt",
      async () => {
        const imported = await library!.importApk(apkPath, aapt);
        assert.equal(imported.app.packageName, "com.local.ktv");
        assert.equal(imported.app.versionName, "2.1.8");
        assert.equal(imported.app.versionCode, "11");
        assert.equal(imported.duplicate, false);
        assert.deepEqual(imported.app.installed, {});
        return imported.app;
      },
    );
    await step("Verify duplicate import and persistent library", async () => {
      const duplicate = await library!.importApk(apkPath, aapt);
      assert(duplicate.duplicate);
      const reopened = new AppLibrary(temporaryDirectory!);
      await reopened.init();
      assert.equal(reopened.getApps().length, 1);
      assert.equal(reopened.getApp(entry!.id).id, entry!.id);
      return { duplicate: true, persisted: true };
    });
    await step("Install APK on real Android device", async () => {
      const result = await runtime.install(
        entry!,
        library!.getApkPath(entry!.id),
        mode,
        settings,
        progress,
      );
      installed = true;
      await library!.markInstalled(entry!.id, mode, result.avd);
      entry = library!.getApp(entry!.id);
      assert.equal(entry.installed[mode]?.avd, avd);
      const installedPackages = await adbShell(
        "pm",
        "list",
        "packages",
        entry.packageName,
      );
      assert(
        installedPackages
          .split(/\r?\n/)
          .includes(`package:${entry.packageName}`),
      );
      const reopened = new AppLibrary(temporaryDirectory!);
      await reopened.init();
      assert.equal(reopened.getApp(entry.id).installed[mode]?.avd, avd);
      return { installedAvd: avd, persistedDesktopMarker: true };
    });
    await step(
      "Grant declared storage permissions for unattended menu test",
      async () => {
        const permissions = [
          "android.permission.READ_EXTERNAL_STORAGE",
          "android.permission.WRITE_EXTERNAL_STORAGE",
        ];
        for (const permission of permissions)
          await adbShell("pm", "grant", entry!.packageName, permission);
        return { granted: permissions, microphonePermissionGranted: false };
      },
    );
    await step("Open application in real scrcpy video window", async () => {
      await runtime.launch(entry!, mode, settings, progress);
      return { receivedVideoTexture: true };
    });
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await screenshot("01-startup.png");
    await step(
      "Verify live APK process and foreground activity after startup",
      foreground,
    );
    await step(
      "Exercise D-pad navigation without starting media playback",
      async () => {
        for (const key of [
          "KEYCODE_DPAD_RIGHT",
          "KEYCODE_DPAD_DOWN",
          "KEYCODE_DPAD_LEFT",
          "KEYCODE_DPAD_UP",
        ]) {
          await adbShell("input", "keyevent", key);
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await screenshot("02-after-dpad.png");
        return {
          sentKeys: ["RIGHT", "DOWN", "LEFT", "UP"],
          ...(await foreground()),
        };
      },
    );
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    // Capture diagnostics before uninstall removes the package/process.
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
      ]).catch((error) => String(error));
      await writeFile(path.join(artifactDirectory, "logcat.txt"), logcat);
    }
    if (installed && entry && library) {
      try {
        await step("Uninstall test APK and clear desktop marker", async () => {
          await runtime.uninstall(entry!, mode, settings, progress);
          await library!.markUninstalled(entry!.id, mode);
          const packages = await adbShell(
            "pm",
            "list",
            "packages",
            entry!.packageName,
          );
          assert(
            !packages.split(/\r?\n/).includes(`package:${entry!.packageName}`),
          );
          assert.equal(library!.getApp(entry!.id).installed[mode], undefined);
          return { removedFromDevice: true, desktopMarkerCleared: true };
        });
      } catch (error) {
        report.status = "failed";
        report.cleanupError = String(error);
        process.exitCode = 1;
      }
    }
    await runtime.dispose().catch((error) => {
      report.status = "failed";
      report.shutdownError = String(error);
      process.exitCode = 1;
    });
    if (temporaryDirectory)
      await rm(temporaryDirectory, { recursive: true, force: true });
    report.completedAt = new Date().toISOString();
    await writeFile(
      path.join(artifactDirectory, "summary.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report, null, 2));
  }
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
