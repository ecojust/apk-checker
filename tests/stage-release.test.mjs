import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  platforms, createDraftRelease, releaseByTag, sha256, stageInstallers, validateChangedFiles, validateRun, verifyPlatformDirectory,
} from "../scripts/stage-release.mjs";

const temporary = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function directory() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "apk-release-test-"));
  temporary.push(dir);
  return dir;
}
async function fixture(dir, config, version = "0.2.4") {
  await mkdir(dir, { recursive: true });
  const name = "APK Checker-" + version + "-" + config.suffix;
  const bytes = Buffer.from("fixture installer: " + config.arch + ":" + config.platform);
  const digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path.join(dir, name), bytes);
  await writeFile(path.join(dir, "SHA256SUMS.txt"), digest + "  " + name + "\n");
  await writeFile(path.join(dir, "portable-tools-verification.json"), JSON.stringify({
    platform: config.platform, arch: config.arch, status: "passed",
    privateAdbAutostartAndCleanupVerified: true, displayLogStreamingVerified: true,
  }));
  if (config.platform === "darwin") {
    await writeFile(path.join(dir, "mac-verification.json"), JSON.stringify({
      status: "passed", host: { platform: "darwin", arch: config.arch }, artifact: name,
      binaryArchitectures: config.binaryArch, runtimeResources: { target: "darwin-" + config.arch, verified: true },
      dmgIntegrityVerified: true, mountedBundleSignatureVerified: true, copiedBundleSignatureVerified: true,
      managedFirstRunVerified: true, rendererStarted: true, preloadIpcVerified: true,
      bundleUnchangedAfterLaunch: true, signing: "ad-hoc", notarized: false,
    }));
  }
  return { name, bytes, digest };
}
const metadata = {
  version: "0.2.4", repository: "ecojust/apk-checker", runId: "123", runUrl: "https://github.com/ecojust/apk-checker/actions/runs/123",
  sourceSha: "a".repeat(40), targetSha: "b".repeat(40),
  artifacts: platforms.map((config, index) => ({ id: index + 1, name: config.artifact })),
};

describe("verified release staging", () => {
  it("stages exactly three unchanged installers, combined hashes and source provenance", async () => {
    const base = await directory();
    for (const config of platforms) await fixture(path.join(base, "input", config.key), config);
    const output = path.join(base, "prepared");
    const provenance = await stageInstallers(path.join(base, "input"), output, metadata);
    expect(await readdir(output)).toHaveLength(5);
    expect(provenance.builtSource).toBe(metadata.sourceSha);
    expect(provenance.tagTarget).toBe(metadata.targetSha);
    const sums = await readFile(path.join(output, "SHA256SUMS.txt"), "utf8");
    for (const config of platforms) {
      const name = "APK-Checker-0.2.4-" + config.suffix;
      expect(sums).toContain(await sha256(path.join(output, name)) + "  " + name + "\n");
      expect(await readFile(path.join(output, name))).toEqual(
        await readFile(path.join(base, "input", config.key, "APK Checker-0.2.4-" + config.suffix)),
      );
    }
  });
  it("rejects modified bytes before creating any prepared assets", async () => {
    const base = await directory();
    for (const config of platforms) await fixture(path.join(base, "input", config.key), config);
    await writeFile(path.join(base, "input", "windows", "APK Checker-0.2.4-win-x64.exe"), "corrupted");
    const output = path.join(base, "prepared");
    await expect(stageInstallers(path.join(base, "input"), output, metadata)).rejects.toThrow("SHA-256 mismatch");
    await expect(readdir(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects a native report for a different architecture", async () => {
    const base = await directory();
    await fixture(base, platforms[0]);
    const file = path.join(base, "mac-verification.json");
    const report = JSON.parse(await readFile(file, "utf8"));
    report.binaryArchitectures = "x86_64";
    await writeFile(file, JSON.stringify(report));
    await expect(verifyPlatformDirectory(platforms[0], base, "0.2.4")).rejects.toThrow("binary architecture");
  });
  it("rejects an installer missing from an otherwise successful artifact", async () => {
    const base = await directory();
    const installed = await fixture(base, platforms[2]);
    await rm(path.join(base, installed.name));
    await expect(verifyPlatformDirectory(platforms[2], base, "0.2.4")).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform === "win32")("rejects a symlink instead of verified installer bytes", async () => {
    const base = await directory();
    const installed = await fixture(base, platforms[2]);
    const outside = path.join(base, "external.exe");
    await writeFile(outside, installed.bytes);
    await rm(path.join(base, installed.name));
    await symlink(outside, path.join(base, installed.name));
    await expect(verifyPlatformDirectory(platforms[2], base, "0.2.4")).rejects.toThrow("regular file");
  });
  it("rejects missing startup verification even when the installer hash matches", async () => {
    const base = await directory();
    await fixture(base, platforms[1]);
    const file = path.join(base, "mac-verification.json");
    const report = JSON.parse(await readFile(file, "utf8"));
    report.rendererStarted = false;
    await writeFile(file, JSON.stringify(report));
    await expect(verifyPlatformDirectory(platforms[1], base, "0.2.4")).rejects.toThrow("rendererStarted");
  });
});

describe("release build provenance", () => {
  const run = {
    id: 123, repository: { full_name: "ecojust/apk-checker" },
    head_repository: { full_name: "ecojust/apk-checker" },
    path: ".github/workflows/build.yml", status: "completed", conclusion: "success", head_sha: "a".repeat(40),
  };
  it("accepts the repository build but rejects fork, wrong workflow and failed or unfinished runs", () => {
    expect(() => validateRun(run, "ecojust/apk-checker", "123")).not.toThrow();
    for (const change of [
      { head_repository: { full_name: "another/apk-checker" } },
      { path: ".github/workflows/release.yml" }, { conclusion: "failure" }, { status: "in_progress" },
    ]) expect(() => validateRun({ ...run, ...change }, "ecojust/apk-checker", "123")).toThrow();
  });
  it("permits documentation/publisher updates but rejects production and version differences", () => {
    expect(() => validateChangedFiles(["README.md", "docs/releases/v0.2.4.md", "history/INDEX.md", ".github/workflows/release.yml", "scripts/stage-release.mjs"])).not.toThrow();
    for (const file of ["src/App.tsx", "electron/main.ts", "package.json", "package-lock.json", ".github/workflows/build.yml"]) {
      expect(() => validateChangedFiles([file])).toThrow("Production differs");
    }
  });
});



it("finds a pending draft by authenticated listing and release ID without requiring an existing tag", () => {
  const called = [];
  const draft = { id: 42, tag_name: "v0.2.4", draft: true, assets: [] };
  const result = releaseByTag("ecojust/apk-checker", "v0.2.4", (endpoint) => {
    called.push(endpoint);
    if (endpoint === "repos/ecojust/apk-checker/releases?per_page=100&page=1") return [draft];
    if (endpoint === "repos/ecojust/apk-checker/releases/42") return draft;
    throw new Error("REST lookup by pending tag returns 404");
  });
  expect(result).toBe(draft);
  expect(called).toEqual([
    "repos/ecojust/apk-checker/releases?per_page=100&page=1",
    "repos/ecojust/apk-checker/releases/42",
  ]);
});


it("uses the POST creation response even while the new draft is absent from release listings", () => {
  const calls = [];
  const target = "a".repeat(40);
  const created = { id: 42, tag_name: "v0.2.4", target_commitish: target, draft: true, assets: [] };
  const result = createDraftRelease("ecojust/apk-checker", "v0.2.4", target, "Line 1\nLine 2", (endpoint, body) => {
    calls.push({ endpoint, body });
    // Only POST /releases is available; lookup/list visibility is not required.
    if (endpoint !== "repos/ecojust/apk-checker/releases" || !body) throw new Error("Draft is not yet visible");
    return created;
  });
  expect(result).toBe(created);
  expect(result.id).toBe(42);
  expect(calls).toEqual([{ endpoint: "repos/ecojust/apk-checker/releases", body: {
    tag_name: "v0.2.4", target_commitish: target, name: "APK Checker v0.2.4",
    body: "Line 1\nLine 2", draft: true, prerelease: false,
  } }]);
});
