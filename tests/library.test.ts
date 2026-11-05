import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const { runAapt } = vi.hoisted(() => ({ runAapt: vi.fn() }));
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: runAapt }) };
});

import { AppLibrary, parseApkBadging } from "../electron/library";

const BADGING = `package: name='com.example.viewer' versionCode='12' versionName='1.2'
sdkVersion:'23'
application-label:'Viewer'
application-label-zh-CN:'电视播放器'
launchable-activity: name='com.example.viewer.MainActivity' label='Viewer' icon='res/icon.png'
leanback-launchable-activity: name='com.example.viewer.TvActivity' label='TV' icon='res/icon.png'
`;
const bytes = (content = "APK contents") =>
  Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(content)]);

describe("parseApkBadging", () => {
  it("reads Unicode labels, package versions and mode-specific launch activities", () => {
    expect(parseApkBadging(BADGING)).toEqual({
      name: "电视播放器",
      packageName: "com.example.viewer",
      versionName: "1.2",
      versionCode: "12",
      minSdk: "23",
      launchableActivity: "com.example.viewer.MainActivity",
      tvActivity: "com.example.viewer.TvActivity",
    });
  });

  it("falls back to the package name and version code for APKs without labels or version names", () => {
    expect(
      parseApkBadging("package: name='com.example.minimal' versionCode='1'\n"),
    ).toMatchObject({
      name: "com.example.minimal",
      versionName: "1",
    });
  });

  it("rejects missing metadata and unsafe package identifiers", () => {
    expect(() => parseApkBadging("")).toThrow("包名");
    expect(() =>
      parseApkBadging("package: name='com.example;reboot' versionCode='1'"),
    ).toThrow("包名");
    expect(() =>
      parseApkBadging("package: name='com.example.app' versionCode='NaN'"),
    ).toThrow("版本");
    expect(() =>
      parseApkBadging("package: name='com.1example.app' versionCode='1'"),
    ).toThrow("包名");
    expect(
      parseApkBadging("package: name='_com._example.app' versionCode='1'")
        .packageName,
    ).toBe("_com._example.app");
  });

  it("handles escaped apostrophes in metadata", () => {
    expect(
      parseApkBadging(
        "package: name='com.example.app' versionCode='1' versionName='it\\'s 1'\napplication-label:'It\\'s a viewer'\n",
      ),
    ).toMatchObject({ name: "It's a viewer", versionName: "it's 1" });
  });
});

describe("AppLibrary persistence", () => {
  let directory: string;
  let root: string;
  let source: string;
  let library: AppLibrary;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "apk-checker-test-"));
    root = path.join(directory, "data");
    source = path.join(directory, "source file.apk");
    await writeFile(source, bytes());
    library = new AppLibrary(root);
    await library.init();
    runAapt.mockReset();
    runAapt.mockResolvedValue({ stdout: BADGING, stderr: "" });
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("copies APKs, hashes content, persists metadata and passes arguments without a shell", async () => {
    const { app } = await library.importApk(source, "/SDK with spaces/aapt2");
    expect(app.id).toBe(createHash("sha256").update(bytes()).digest("hex"));
    expect(app.fileName).toBe("source file.apk");
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
    expect(runAapt).toHaveBeenCalledWith(
      "/SDK with spaces/aapt2",
      ["dump", "badging", expect.stringContaining(".tmp.apk")],
      {
        timeout: 60_000,
        maxBuffer: 8 * 1024 ** 2,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    const reopened = new AppLibrary(root);
    await reopened.init();
    expect(reopened.getApps()).toEqual([app]);
  });

  it("deduplicates identical APK contents without re-parsing or losing installed records", async () => {
    const { app } = await library.importApk(source, "aapt");
    await library.markInstalled(app.id, "phone", "Pixel_8");
    const result = await library.importApk(source, "aapt");
    expect(result.duplicate).toBe(true);
    expect(result.app.installed.phone?.avd).toBe("Pixel_8");
    expect(runAapt).toHaveBeenCalledTimes(1);
    expect(await readdir(path.join(root, "apks"))).toEqual([`${app.id}.apk`]);
  });

  it("repairs a missing cached APK on duplicate import without losing installed records", async () => {
    const { app } = await library.importApk(source, "aapt");
    await library.markInstalled(app.id, "phone", "Pixel_8");
    await rm(library.getApkPath(app.id));
    const result = await library.importApk(source, "aapt");
    expect(result.duplicate).toBe(true);
    expect(result.app.installed.phone?.avd).toBe("Pixel_8");
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
  });

  it("replaces a package update and requires explicitly installing the new version", async () => {
    const { app: old } = await library.importApk(source, "aapt");
    await library.markInstalled(old.id, "phone", "Pixel_8");
    await writeFile(source, bytes("new apk"));
    runAapt.mockResolvedValue({
      stdout: BADGING.replace("versionCode='12'", "versionCode='13'"),
      stderr: "",
    });
    const result = await library.importApk(source, "aapt");
    expect(result.replaced).toBe(true);
    expect(result.app.versionCode).toBe("13");
    expect(result.app.installed).toEqual({});
    expect(library.getApps()).toHaveLength(1);
    expect(await readdir(path.join(root, "apks"))).toEqual([
      `${result.app.id}.apk`,
    ]);
    expect(await readFile(source)).toEqual(bytes("new apk"));
  });

  it("tracks separate phone and TV installations and retains them across restarts", async () => {
    const { app } = await library.importApk(source, "aapt");
    await library.markInstalled(app.id, "phone", "Pixel_8");
    await library.markInstalled(app.id, "tv", "Android_TV");
    await library.markUninstalled(app.id, "phone");
    const reopened = new AppLibrary(root);
    await reopened.init();
    expect(reopened.getApp(app.id).installed).toEqual({
      tv: { avd: "Android_TV", installedAt: expect.any(String) },
    });
  });

  it("returns copies so renderer state cannot accidentally mutate persisted records", async () => {
    const { app } = await library.importApk(source, "aapt");
    await library.markInstalled(app.id, "phone", "Pixel_8");
    const copy = library.getApps();
    copy[0].name = "changed";
    copy[0].installed.phone!.avd = "changed";
    expect(library.getApp(app.id).name).toBe("电视播放器");
    expect(library.getApp(app.id).installed.phone!.avd).toBe("Pixel_8");
  });

  it("removes cached APKs while keeping the user-selected source file untouched", async () => {
    const { app } = await library.importApk(source, "aapt");
    await library.removeApp(app.id);
    expect(library.getApps()).toEqual([]);
    expect(await readFile(source)).toEqual(bytes());
    expect(await readdir(path.join(root, "apks"))).toEqual([]);
    expect(() => library.getApkPath("../../outside")).toThrow("不在软件库");
  });

  it("rejects invalid files before invoking aapt and cleans temporary copies", async () => {
    await writeFile(source, "not an APK");
    await expect(library.importApk(source, "aapt")).rejects.toThrow("ZIP");
    await expect(
      library.importApk(path.join(directory, "foo.zip"), "aapt"),
    ).rejects.toThrow(".apk");
    expect(runAapt).not.toHaveBeenCalled();
    expect(await readdir(path.join(root, "apks"))).toEqual([]);
  });

  it("leaves the existing library unchanged when aapt cannot parse an update", async () => {
    const { app } = await library.importApk(source, "aapt");
    await writeFile(source, bytes("broken manifest"));
    runAapt.mockRejectedValue(
      Object.assign(new Error("failed"), {
        stderr: "AndroidManifest.xml missing",
      }),
    );
    await expect(library.importApk(source, "aapt")).rejects.toThrow(
      "AndroidManifest.xml missing",
    );
    expect(library.getApps()).toEqual([app]);
    expect(await readdir(path.join(root, "apks"))).toEqual([`${app.id}.apk`]);
  });

  it("rolls back cached files and in-memory state if the index cannot be committed", async () => {
    await mkdir(path.join(root, "library.json"));
    await expect(library.importApk(source, "aapt")).rejects.toThrow();
    expect(library.getApps()).toEqual([]);
    expect(await readdir(path.join(root, "apks"))).toEqual([]);
    expect(await readdir(root)).toEqual(
      expect.arrayContaining(["apks", "library.json"]),
    );
    expect((await readdir(root)).some((entry) => entry.endsWith(".tmp"))).toBe(
      false,
    );
  });

  it("keeps an existing APK and its installation records when a replacement commit fails", async () => {
    const { app } = await library.importApk(source, "aapt");
    await library.markInstalled(app.id, "phone", "Pixel_8");
    const before = library.getApps();
    await writeFile(source, bytes("new version"));
    const index = path.join(root, "library.json");
    await rename(index, `${index}.saved`);
    await mkdir(index);
    await expect(library.importApk(source, "aapt")).rejects.toThrow();
    expect(library.getApps()).toEqual(before);
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
    expect(await readdir(path.join(root, "apks"))).toEqual([`${app.id}.apk`]);
    expect(await readFile(source)).toEqual(bytes("new version"));
  });

  it("does not remove a cached APK if removing its library record cannot be committed", async () => {
    const { app } = await library.importApk(source, "aapt");
    const index = path.join(root, "library.json");
    await rename(index, `${index}.saved`);
    await mkdir(index);
    await expect(library.removeApp(app.id)).rejects.toThrow();
    expect(library.getApps()).toEqual([app]);
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
    expect(await readFile(source)).toEqual(bytes());
  });

  it("validates and persists settings without sharing mutable references", async () => {
    const settings = {
      sdkPath: " /my/sdk ",
      scrcpyPath: "",
      phoneAvd: "Pixel_8",
      tvAvd: "TV",
      defaultMode: "tv" as const,
    };
    await library.saveSettings(settings);
    settings.phoneAvd = "changed";
    expect(library.getSettings().phoneAvd).toBe("Pixel_8");
    const reopened = new AppLibrary(root);
    await reopened.init();
    expect(reopened.getSettings()).toMatchObject({
      sdkPath: "/my/sdk",
      defaultMode: "tv",
    });
    await expect(
      library.saveSettings({ ...settings, defaultMode: "tablet" as "tv" }),
    ).rejects.toThrow("模式");
  });

  it("backs up a corrupted index and keeps the original to prevent silent loss on the next launch", async () => {
    const corrupt = "{truncated JSON";
    await writeFile(path.join(root, "library.json"), corrupt);
    await expect(new AppLibrary(root).init()).rejects.toThrow("原文件未修改");
    expect(await readFile(path.join(root, "library.json"), "utf8")).toBe(
      corrupt,
    );
    const backup = (await readdir(root)).find((entry) =>
      entry.endsWith(".bak"),
    );
    expect(backup).toBeDefined();
    expect(await readFile(path.join(root, backup!), "utf8")).toBe(corrupt);
    await expect(new AppLibrary(root).init()).rejects.toThrow("原文件未修改");
  });
});
