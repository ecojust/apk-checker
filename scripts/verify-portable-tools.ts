import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { AndroidRuntime } from "../electron/android";
import { displayCommand } from "../electron/display";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ManagedRuntime } from "../electron/managed-runtime";

async function packagedResources(): Promise<string> {
  if (process.argv[2]) return path.resolve(process.argv[2]);
  if (process.platform === "win32") return path.resolve("release/win-unpacked/resources");
  const directory = path.resolve("release", process.arch === "arm64" ? "mac-arm64" : "mac");
  const apps = (await readdir(directory)).filter(file => file.endsWith(".app"));
  assert.equal(apps.length, 1);
  return path.join(directory, apps[0], "Contents/Resources");
}

function listening(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (result: boolean) => { socket.destroy(); resolve(result); };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function verifyLiveLogs(executable: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (process.platform === "win32") return;
  let probeDirectory: string | undefined;
  let probe = executable;
  let args = ["--pause-on-exit=true", "--apk-checker-test-invalid-option"];
  let marker = "scrcpy 5.0.1";
  if (process.platform === "darwin") {
    // Node's pipe is a socketpair: BSD script rejects its terminal ioctl.
    // Production uses /dev/null stdin. Verify that exact setup using a native
    // libc stdout writer which deliberately never fflush()es and never reads stdin.
    probeDirectory = await mkdtemp(path.join(tmpdir(), "apk-checker-pty-probe-"));
    const source = path.join(probeDirectory, "probe.c");
    probe = path.join(probeDirectory, "probe");
    marker = "APK_CHECKER_LIVE_PTY";
    await writeFile(source, '#include <stdio.h>\n#include <unistd.h>\nint main(void) { puts("APK_CHECKER_LIVE_PTY"); sleep(60); return 0; }\n');
    await promisify(execFile)("/usr/bin/cc", ["-Wall", "-Werror", source, "-o", probe]);
    args = [];
  }
  const invocation = displayCommand(probe, args);
  const child = spawn(invocation.file, invocation.args, { env, stdio: [process.platform === "darwin" ? "ignore" : "pipe", "pipe", "pipe"] });
  let descendants: number[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      let output = "";
      let errors = "";
      child.stderr?.on("data", data => { errors = (errors + String(data)).slice(-4000); });
      const timer = setTimeout(() => reject(new Error("Live scrcpy stdout was buffered until exit")), 10000);
      child.stdout!.on("data", data => {
        output += String(data);
        if (output.includes(marker)) { clearTimeout(timer); resolve(); }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); reject(new Error(`Probe exited before live logs: code=${code} signal=${signal}; ${errors} ${output}`)); });
    });
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(child.exitCode, null, "The real scrcpy probe must remain alive after logs arrive");
    assert.equal(child.signalCode, null);
    if (process.platform === "darwin") {
      const result = await promisify(execFile)("/usr/bin/pgrep", ["-P", String(child.pid)]);
      descendants = result.stdout.trim().split(/\s+/).map(Number);
      assert(descendants.length > 0 && descendants.every(pid => Number.isInteger(pid) && pid > 1));
    }
  } finally {
    const exited = new Promise<void>((resolve, reject) => {
      if (child.exitCode !== null || child.signalCode) return resolve();
      const timer = setTimeout(() => reject(new Error("Display probe did not exit after termination")), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    child.kill();
    child.stdin?.destroy();
    await exited;
    for (const pid of descendants) {
      let alive = true;
      const deadline = Date.now() + 5000;
      while (alive && Date.now() < deadline) {
        try { process.kill(pid, 0); } catch { alive = false; }
        if (alive) await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (alive) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } }
      assert.equal(alive, false, "The owned PTY display child must exit with its wrapper");
    }
    if (probeDirectory) await rm(probeDirectory, { recursive: true, force: true });
  }
}

async function main() {
  await mkdir("release", { recursive: true });
  const report: Record<string, unknown> = {
    platform: process.platform, arch: process.arch,
    scope: "Packaged portable tools extracted by ManagedRuntime and executed natively; no Android boot or media test",
  };
  const root = await mkdtemp(path.join(tmpdir(), "apk-checker-portable-"));
  let managed: ManagedRuntime | undefined;
  let runtime: AndroidRuntime | undefined;
  try {
    const resources = await packagedResources();
    const catalog = JSON.parse(await readFile(path.join(resources, "runtime-catalog.json"), "utf8"));
    managed = new ManagedRuntime(root, resources);
    await managed.init();
    // Test-only access isolates the bundled core. prepare() also downloads the
    // multi-gigabyte Android engine/image and requires separate end-to-end CI.
    const extractor = managed as unknown as {
      installComponent(component: unknown, progress: (message: string) => void, signal: AbortSignal): Promise<void>;
    };
    for (const component of catalog.platforms[`${process.platform}-${process.arch}`].components.filter((item: { bundle: boolean }) => item.bundle))
      await extractor.installComponent(component, console.log, new AbortController().signal);
    const settings = managed.getSettings();
    const commands: [string, string[]][] = [
      [path.join(settings.sdkPath, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb"), ["version"]],
      [settings.scrcpyPath, ["--version"]],
    ];
    const versions = [];
    for (const [file, args] of commands) {
      const result = await promisify(execFile)(file, args, {
        env: { ...process.env, ...managed.getEnvironment() }, timeout: 30000,
      });
      versions.push({ binary: path.basename(file), output: result.stdout + result.stderr });
    }
    assert.match(versions[0].output, /Android Debug Bridge/);
    assert.match(versions[1].output, /scrcpy 5\.0\.1/);
    report.versions = versions;
    await verifyLiveLogs(settings.scrcpyPath, { ...process.env, ...managed.getEnvironment() });
    if (process.platform !== "win32") {
      report.displayLogStreamingVerified = true;
      report.displayLogProbe = process.platform === "darwin" ? "Native unflushed libc writer via production BSD PTY and /dev/null stdin; child exit verified" : "Real scrcpy with line buffering and an open pause-on-exit stdin";
    }
    else report.displayLogStreamingCheck = "Unix-only probe; the upstream Windows binary disables stdout buffering";
    const environment = managed.getEnvironment();
    const port = Number(environment.ANDROID_ADB_SERVER_PORT);
    assert.notEqual(port, 5037);
    runtime = new AndroidRuntime(undefined, environment);
    const status = await runtime.getStatus(settings);
    assert.equal(status.adbFound, true);
    assert.equal(await listening(port), true, "Private adb must auto-start on first use");
    await runtime.dispose();
    assert.equal(await listening(port), false, "Private adb must stop during shutdown");
    report.privateAdbAutostartAndCleanupVerified = true;
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    console.error(`::error::${String(report.error).replaceAll("%", "%25").replaceAll("\n", "%0A").replaceAll("\r", "%0D")}`);
    process.exitCode = 1;
  } finally {
    await runtime?.dispose();
    await managed?.dispose();
    await rm(root, { recursive: true, force: true });
    console.log(JSON.stringify(report, null, 2));
    await writeFile("release/portable-tools-verification.json", JSON.stringify(report, null, 2));
  }

}
void main().catch(error => { console.error(error); process.exitCode = 1; });
