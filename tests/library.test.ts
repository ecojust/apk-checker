import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Settings } from "../src/shared/types";

const { parseMetadata } = vi.hoisted(() => ({ parseMetadata: vi.fn() }));
vi.mock("../electron/apk-metadata", () => ({ readApkMetadata: parseMetadata }));

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
    parseMetadata.mockReset();
    parseMetadata.mockResolvedValue(parseApkBadging(BADGING));
  });

  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });

  it("copies APKs, hashes content and persists metadata using the embedded parser", async () => {
    const { app } = await library.importApk(source, "/SDK with spaces/aapt2");
    expect(app.id).toBe(createHash("sha256").update(bytes()).digest("hex"));
    expect(app.fileName).toBe("source file.apk");
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
    expect(parseMetadata).toHaveBeenCalledWith(
      expect.stringContaining(".tmp.apk"),
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
    expect(parseMetadata).toHaveBeenCalledTimes(1);
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
    parseMetadata.mockResolvedValue(
      parseApkBadging(BADGING.replace("versionCode='12'", "versionCode='13'")),
    );
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

  it("rejects invalid files before invoking the embedded parser and cleans temporary copies", async () => {
    await writeFile(source, "not an APK");
    await expect(library.importApk(source, "aapt")).rejects.toThrow("ZIP");
    await expect(
      library.importApk(path.join(directory, "foo.zip"), "aapt"),
    ).rejects.toThrow(".apk");
    expect(parseMetadata).not.toHaveBeenCalled();
    expect(await readdir(path.join(root, "apks"))).toEqual([]);
  });

  it("leaves the existing library unchanged when the embedded parser cannot parse an update", async () => {
    const { app } = await library.importApk(source, "aapt");
    await writeFile(source, bytes("broken manifest"));
    parseMetadata.mockRejectedValue(new Error("AndroidManifest.xml missing"));
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
  const managedSettings = (): Settings => ({
    sdkPath: path.join(root, "runtime", "sdk"),
    scrcpyPath: path.join(root, "runtime", "scrcpy"),
    phoneAvd: "APKChecker_Phone_30_arm64_v8a",
    tvAvd: "APKChecker_TV_36_arm64_v8a",
    defaultMode: "phone",
  });

  it("backs up the exact legacy index before atomically adopting managed settings and removing old associations", async () => {
    const { app } = await library.importApk(source);
    await library.saveSettings({
      sdkPath: path.join(directory, "external-sdk"),
      scrcpyPath: path.join(directory, "external-tools", "scrcpy"),
      phoneAvd: "Old_Pixel",
      tvAvd: "Old_TV",
      defaultMode: "tv",
    });
    await library.markInstalled(app.id, "phone", "Old_Pixel");
    await library.markInstalled(app.id, "tv", "Old_TV");
    const before = library.getApp(app.id);
    const originalIndex = await readFile(path.join(root, "library.json"));
    const oldAvd = path.join(directory, "external-avds", "Old_Pixel.avd");
    await mkdir(oldAvd, { recursive: true });
    await writeFile(
      path.join(oldAvd, "userdata.img"),
      "existing Android user data",
    );

    expect(await library.adoptManagedSettings(managedSettings())).toBe(2);
    expect(library.getSettings()).toEqual(managedSettings());
    expect(library.getApp(app.id)).toEqual({ ...before, installed: {} });
    const backups = (await readdir(root)).filter((entry) =>
      entry.startsWith("library.json.before-managed-"),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(root, backups[0]))).toEqual(originalIndex);
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
    expect(await readFile(source)).toEqual(bytes());
    expect(await readFile(path.join(oldAvd, "userdata.img"), "utf8")).toBe(
      "existing Android user data",
    );
    const reopened = new AppLibrary(root);
    await reopened.init();
    expect(reopened.getSettings()).toEqual(managedSettings());
    expect(reopened.getApp(app.id)).toEqual({ ...before, installed: {} });
  });

  it("retains matching managed installations and drops only associations from another architecture", async () => {
    const { app } = await library.importApk(source);
    await library.markInstalled(app.id, "phone", managedSettings().phoneAvd);
    await library.markInstalled(app.id, "tv", "APKChecker_TV_36_x86_64");
    const phoneRecord = library.getApp(app.id).installed.phone;
    expect(await library.adoptManagedSettings(managedSettings())).toBe(1);
    expect(library.getApp(app.id).installed).toEqual({ phone: phoneRecord });
  });

  it("does not rewrite or back up an unchanged managed library on repeated adoption or restart", async () => {
    const { app } = await library.importApk(source);
    await library.markInstalled(app.id, "phone", managedSettings().phoneAvd);
    await library.markInstalled(app.id, "tv", managedSettings().tvAvd);
    await library.adoptManagedSettings(managedSettings());
    const index = path.join(root, "library.json");
    const stableTime = new Date("2020-01-01T00:00:00.000Z");
    await utimes(index, stableTime, stableTime);
    const beforeStats = await stat(index);
    const beforeFiles = (await readdir(root)).sort();
    const beforeContents = await readFile(index);
    const beforeApps = library.getApps();

    expect(
      await library.adoptManagedSettings({
        ...managedSettings(),
        sdkPath: ` ${managedSettings().sdkPath} `,
      }),
    ).toBe(0);
    const reopened = new AppLibrary(root);
    await reopened.init();
    expect(await reopened.adoptManagedSettings(managedSettings())).toBe(0);
    expect(reopened.getApps()).toEqual(beforeApps);
    expect(await readFile(index)).toEqual(beforeContents);
    expect((await stat(index)).mtimeMs).toBe(beforeStats.mtimeMs);
    expect((await readdir(root)).sort()).toEqual(beforeFiles);
  });

  it("persists managed settings for a fresh library without inventing a legacy backup", async () => {
    expect(await library.adoptManagedSettings(managedSettings())).toBe(0);
    expect((await readdir(root)).sort()).toEqual(["apks", "library.json"]);
    const reopened = new AppLibrary(root);
    await reopened.init();
    expect(reopened.getSettings()).toEqual(managedSettings());
    expect(reopened.getApps()).toEqual([]);
  });

  it("does not apply settings or remove associations if the original index cannot be backed up", async () => {
    const { app } = await library.importApk(source);
    await library.markInstalled(app.id, "phone", "Old_Pixel");
    const beforeApps = library.getApps();
    const beforeSettings = library.getSettings();
    const index = path.join(root, "library.json");
    await rename(index, `${index}.saved`);

    await expect(
      library.adoptManagedSettings(managedSettings()),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(library.getApps()).toEqual(beforeApps);
    expect(library.getSettings()).toEqual(beforeSettings);
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
    expect(
      (await readdir(root)).some((entry) => entry.includes(".before-managed-")),
    ).toBe(false);
  });

  it("keeps a completed migration backup and all original state if the atomic commit fails", async () => {
    const { app } = await library.importApk(source);
    await library.markInstalled(app.id, "tv", "Old_TV");
    const beforeApps = library.getApps();
    const beforeSettings = library.getSettings();
    const original = await readFile(path.join(root, "library.json"));
    const commitFailure = vi
      .spyOn(
        library as unknown as { commit(next: unknown): Promise<void> },
        "commit",
      )
      .mockRejectedValueOnce(new Error("simulated disk write failure"));
    try {
      await expect(
        library.adoptManagedSettings(managedSettings()),
      ).rejects.toThrow("simulated disk write failure");
    } finally {
      commitFailure.mockRestore();
    }
    expect(library.getApps()).toEqual(beforeApps);
    expect(library.getSettings()).toEqual(beforeSettings);
    expect(await readFile(path.join(root, "library.json"))).toEqual(original);
    const backups = (await readdir(root)).filter((entry) =>
      entry.includes(".before-managed-"),
    );
    expect(backups).toHaveLength(1);
    expect(await readFile(path.join(root, backups[0]))).toEqual(original);
    expect(await readFile(library.getApkPath(app.id))).toEqual(bytes());
  });

  it("rejects invalid managed settings before creating a backup", async () => {
    await library.importApk(source);
    const beforeFiles = (await readdir(root)).sort();
    const before = await readFile(path.join(root, "library.json"));
    await expect(
      library.adoptManagedSettings({
        ...managedSettings(),
        defaultMode: "invalid" as "phone",
      }),
    ).rejects.toThrow("模式");
    expect((await readdir(root)).sort()).toEqual(beforeFiles);
    expect(await readFile(path.join(root, "library.json"))).toEqual(before);
  });
});
