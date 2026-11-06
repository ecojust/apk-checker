import assert from "node:assert/strict";
import { verifyRuntimeResources } from "./verify-runtime-resources.mjs";
import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

assert.equal(
  process.platform,
  "darwin",
  "Run this check on a native macOS host",
);
const output = path.resolve("release");
const expectedArch = process.env.EXPECTED_MAC_ARCH || process.arch;
assert.equal(
  process.arch,
  expectedArch,
  "The runner must use the package architecture natively",
);
const report = {
  startedAt: new Date().toISOString(),
  host: { platform: process.platform, arch: process.arch },
  signing: "ad-hoc",
  notarized: false,
  launchMethod: "Packaged executable with an isolated temporary user profile",
  gatekeeperLimit:
    "Signature integrity and actual startup are tested; a quarantined download still needs user approval because this build is not Developer ID notarized.",
  status: "running",
};
const scratch = await mkdtemp(path.join(tmpdir(), "apk-checker-mac-verify-"));
const mount = path.join(scratch, "mounted");
let mounted = false;
let child;
let socket;
let launchLog = "";

function command(file, args, { allowFailure = false, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout, maxBuffer: 8 * 1024 ** 2 },
      (error, stdout, stderr) => {
        const result = { code: error ? (error.code ?? 1) : 0, stdout, stderr };
        if (error && !allowFailure)
          reject(new Error(`${file}: ${stderr || stdout || error.message}`));
        else resolve(result);
      },
    );
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function connectToPage(port) {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error(
        `Packaged application exited before rendering: ${launchLog}`,
      );
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1500),
      });
      const targets = await response.json();
      const page = targets.find(
        (target) => target.type === "page" && target.url.startsWith("file:"),
      );
      if (page?.webSocketDebuggerUrl) {
        const connection = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("DevTools WebSocket timed out")),
            5000,
          );
          connection.addEventListener(
            "open",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
          connection.addEventListener(
            "error",
            () => {
              clearTimeout(timer);
              reject(new Error("DevTools WebSocket failed"));
            },
            { once: true },
          );
        });
        return connection;
      }
    } catch {
      /* The browser process may still be starting. */
    }
    await delay(300);
  }
  throw new Error(
    `No packaged renderer appeared within 45 seconds: ${launchLog}`,
  );
}

let messageId = 0;
function cdp(method, params = {}) {
  const id = ++messageId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.removeEventListener("message", onMessage);
      reject(new Error(`${method} timed out`));
    }, 45000);
    function onMessage(event) {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

try {
  await mkdir(mount);
  const files = await readdir(output);
  const dmgFiles = files.filter((file) =>
    file.endsWith(`-mac-${expectedArch}.dmg`),
  );
  assert.equal(
    dmgFiles.length,
    1,
    "Expected exactly one DMG for this architecture",
  );
  const dmg = path.join(output, dmgFiles[0]);
  report.artifact = dmgFiles[0];
  await command("hdiutil", ["verify", dmg]);
  report.dmgIntegrityVerified = true;
  await command("hdiutil", [
    "attach",
    dmg,
    "-readonly",
    "-nobrowse",
    "-mountpoint",
    mount,
  ]);
  mounted = true;
  const apps = (await readdir(mount)).filter((file) => file.endsWith(".app"));
  assert.equal(apps.length, 1, "The DMG must contain one application");
  const mountedApp = path.join(mount, apps[0]);
  await command("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    mountedApp,
  ]);
  report.mountedBundleSignatureVerified = true;
  const signature = await command("codesign", [
    "--display",
    "--verbose=4",
    mountedApp,
  ]);
  report.signature = `${signature.stdout}${signature.stderr}`;
  assert.match(
    report.signature,
    /Signature=adhoc/,
    "Expected an explicit complete ad-hoc signature",
  );
  const entitlements = await command("codesign", [
    "--display",
    "--entitlements",
    "-",
    mountedApp,
  ]);
  report.entitlements = `${entitlements.stdout}${entitlements.stderr}`;
  assert.match(report.entitlements, /com.apple.security.cs.allow-jit/);
  assert.match(
    report.entitlements,
    /com.apple.security.cs.disable-library-validation/,
  );
  const installedApp = path.join(scratch, apps[0]);
  await command("ditto", [mountedApp, installedApp]);
  await command("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    installedApp,
  ]);
  report.copiedBundleSignatureVerified = true;
  report.runtimeResources = await verifyRuntimeResources(
    path.join(installedApp, "Contents", "Resources"), "darwin", expectedArch,
  );
  const executable = path.join(
    installedApp,
    "Contents",
    "MacOS",
    "APK Checker",
  );
  const architecture = await command("lipo", ["-archs", executable]);
  report.binaryArchitectures = architecture.stdout.trim();
  assert(
    architecture.stdout
      .trim()
      .split(/\s+/)
      .includes(expectedArch === "x64" ? "x86_64" : "arm64"),
  );
  const assessment = await command(
    "spctl",
    ["--assess", "--type", "execute", "--verbose=4", installedApp],
    { allowFailure: true },
  );
  report.gatekeeperAssessment = assessment;
  const port = await unusedPort();
  child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${path.join(scratch, "profile")}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (data) => {
    launchLog += String(data);
  });
  child.stderr.on("data", (data) => {
    launchLog += String(data);
  });
  child.on("error", (error) => {
    launchLog += error.message;
  });
  socket = await connectToPage(port);
  const deadline = Date.now() + 30000;
  let loaded = false;
  while (Date.now() < deadline) {
    loaded = await evaluate(
      "document.readyState === 'complete' && document.body.innerText.includes('桌面') && typeof window.apkChecker === 'object'",
    );
    if (loaded) break;
    await delay(300);
  }
  assert(loaded, "React renderer and preload API did not initialize");
  report.renderer = await evaluate(`(async () => ({
    title: document.title,
    preloadApi: typeof window.apkChecker,
    nodeRequire: typeof window.require,
    nodeProcess: typeof window.process,
    state: await window.apkChecker.getState()
  }))()`);
  assert.equal(report.renderer.title, "APK Checker");
  assert.equal(report.renderer.preloadApi, "object");
  assert.equal(report.renderer.nodeRequire, "undefined");
  assert.equal(report.renderer.nodeProcess, "undefined");
  assert.deepEqual(report.renderer.state.apps, []);
  assert.equal(report.renderer.state.managed.supported, true);
  assert.equal(report.renderer.state.managed.licenseAccepted, false);
  assert.equal(report.renderer.state.managed.phoneReady, false);
  assert.equal(report.renderer.state.managed.tvReady, false);
  assert.equal(await evaluate("typeof window.apkChecker.choosePath"), "undefined");
  const license = await evaluate("window.apkChecker.getRuntimeLicense()");
  assert(license.includes("Android Software Development Kit"));
  report.managedFirstRunVerified = true;
  const screen = await cdp("Page.captureScreenshot", { format: "png" });
  await writeFile(
    path.join(output, "mac-verification.png"),
    Buffer.from(screen.data, "base64"),
  );
  report.rendererStarted = true;
  report.preloadIpcVerified = true;
  await command("codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=4",
    installedApp,
  ]);
  report.bundleUnchangedAfterLaunch = true;
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = error.message;
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    socket?.close();
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 5000;
      while (
        child.exitCode === null &&
        !child.signalCode &&
        Date.now() < deadline
      )
        await delay(100);
      if (child.exitCode === null && !child.signalCode) {
        child.kill("SIGKILL");
        const killDeadline = Date.now() + 3000;
        while (
          child.exitCode === null &&
          !child.signalCode &&
          Date.now() < killDeadline
        )
          await delay(100);
        assert(
          child.exitCode !== null || child.signalCode,
          "The test application did not exit after SIGKILL",
        );
      }
    }
    if (mounted) {
      let detached = await command("hdiutil", ["detach", mount], {
        allowFailure: true,
      });
      if (detached.code !== 0) {
        detached = await command("hdiutil", ["detach", "-force", mount], {
          allowFailure: true,
        });
      }
      assert.equal(
        detached.code,
        0,
        `Could not detach the test DMG: ${detached.stderr}`,
      );
      mounted = false;
    }
    await rm(scratch, { recursive: true, force: true });
  } catch (error) {
    // Never recursively remove a still-mounted volume; preserve diagnostics even
    // when native cleanup fails after successful signature/startup validation.
    report.cleanupError = error.message;
    report.retainedTemporaryDirectory = scratch;
    report.status = "failed";
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await writeFile(
    path.join(output, "mac-verification.json"),
    JSON.stringify(report, null, 2),
  );
  await writeFile(path.join(output, "mac-verification.log"), launchLog);
  console.log(JSON.stringify(report, null, 2));
}
