import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import type { DeviceMode, LibraryApp, Settings } from "../src/shared/types";

import { readApkMetadata } from "./apk-metadata";
const MAX_APK_BYTES = 4 * 1024 ** 3;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const PACKAGE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const DEFAULT_SETTINGS: Settings = {
  sdkPath: "",
  scrcpyPath: "",
  phoneAvd: "",
  tvAvd: "",
  defaultMode: "phone",
};

interface Store {
  schemaVersion: 1;
  apps: LibraryApp[];
  settings: Settings;
}

type ApkMetadata = Pick<
  LibraryApp,
  | "name"
  | "packageName"
  | "versionName"
  | "versionCode"
  | "minSdk"
  | "launchableActivity"
  | "tvActivity"
>;

function attribute(line: string, key: string): string | undefined {
  const match = line.match(
    new RegExp(`(?:^|\\s)${key}='((?:\\\\.|[^'\\\\])*)'`),
  );
  return match?.[1].replace(/\\(['\\])/g, "$1");
}

/** Parse aapt/aapt2 badging without executing anything from APK metadata. */
export function parseApkBadging(output: string): ApkMetadata {
  const lines = output.split(/\r?\n/);
  const packageLine = lines.find((line) => line.startsWith("package:"));
  const packageName = packageLine && attribute(packageLine, "name");
  if (!packageName || !PACKAGE_PATTERN.test(packageName)) {
    throw new Error("无法读取 APK 包名，请确认这是完整、有效的 APK 文件。");
  }
  const versionCode = attribute(packageLine!, "versionCode");
  if (!versionCode || !/^\d+$/.test(versionCode)) {
    throw new Error("APK 缺少有效的版本编号。");
  }
  const label = (prefix: string) => {
    const line = lines.find((entry) => entry.startsWith(`${prefix}:'`));
    return line?.slice(prefix.length + 2, -1).replace(/\\(['\\])/g, "$1");
  };
  const launchLine = lines.find((line) =>
    line.startsWith("launchable-activity:"),
  );
  const tvLine = lines.find((line) =>
    line.startsWith("leanback-launchable-activity:"),
  );
  const sdkLine = lines.find((line) => line.startsWith("sdkVersion:"));
  return {
    packageName,
    name:
      label("application-label-zh-CN") ||
      label("application-label-zh") ||
      label("application-label") ||
      packageName,
    versionName: attribute(packageLine!, "versionName") || versionCode,
    versionCode,
    minSdk: sdkLine?.match(/^sdkVersion:'([^']+)'/)?.[1],
    launchableActivity: launchLine ? attribute(launchLine, "name") : undefined,
    tvActivity: tvLine ? attribute(tvLine, "name") : undefined,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSettings(value: unknown): Settings {
  if (
    !isRecord(value) ||
    !["phone", "tv"].includes(String(value.defaultMode))
  ) {
    throw new Error("无效的运行模式设置。");
  }
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    defaultMode: value.defaultMode as DeviceMode,
  };
  for (const field of ["sdkPath", "scrcpyPath", "phoneAvd", "tvAvd"] as const) {
    if (
      typeof value[field] !== "string" ||
      value[field].length > 4096 ||
      value[field].includes("\0")
    ) {
      throw new Error(`无效的配置项：${field}`);
    }
    settings[field] = value[field].trim();
  }
  return settings;
}

function validateApp(value: unknown): LibraryApp {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !HASH_PATTERN.test(value.id)
  ) {
    throw new Error("软件库包含无效的文件标识。");
  }
  for (const field of [
    "name",
    "packageName",
    "versionName",
    "versionCode",
    "importedAt",
    "fileName",
  ] as const) {
    if (typeof value[field] !== "string")
      throw new Error(`软件库字段损坏：${field}`);
  }
  if (
    !PACKAGE_PATTERN.test(value.packageName as string) ||
    !/^\d+$/.test(value.versionCode as string) ||
    typeof value.size !== "number" ||
    !Number.isSafeInteger(value.size) ||
    value.size < 4 ||
    !isRecord(value.installed)
  )
    throw new Error("软件库元数据损坏。");
  for (const field of ["minSdk", "launchableActivity", "tvActivity"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string")
      throw new Error("软件库元数据损坏。");
  }
  for (const mode of Object.keys(value.installed)) {
    const record = value.installed[mode];
    if (
      !["phone", "tv"].includes(mode) ||
      !isRecord(record) ||
      typeof record.avd !== "string" ||
      !record.avd ||
      typeof record.installedAt !== "string"
    )
      throw new Error("软件安装记录损坏。");
  }
  return structuredClone(value) as unknown as LibraryApp;
}

async function sha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/** The main process serializes writes. APK copies and the JSON index are committed atomically. */
export class AppLibrary {
  private readonly indexPath: string;
  private readonly apkDirectory: string;
  private state: Store = {
    schemaVersion: 1,
    apps: [],
    settings: { ...DEFAULT_SETTINGS },
  };
  private initialized = false;
  private hasPersistedIndex = false;

  constructor(private readonly rootDir: string) {
    this.indexPath = path.join(rootDir, "library.json");
    this.apkDirectory = path.join(rootDir, "apks");
  }

  async init(): Promise<void> {
    await mkdir(this.apkDirectory, { recursive: true, mode: 0o700 });
    let contents: string;
    try {
      const info = await stat(this.indexPath);
      if (info.size > 32 * 1024 ** 2)
        throw new Error("软件库索引超过大小限制。");
      contents = await readFile(this.indexPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.initialized = true;
        return;
      }
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(contents);
      if (
        !isRecord(parsed) ||
        parsed.schemaVersion !== 1 ||
        !Array.isArray(parsed.apps)
      ) {
        throw new Error("不支持的软件库格式。");
      }
      const apps = parsed.apps.map(validateApp);
      if (
        new Set(apps.map((entry) => entry.id)).size !== apps.length ||
        new Set(apps.map((entry) => entry.packageName)).size !== apps.length
      ) {
        throw new Error("软件库存在重复记录。");
      }
      this.state = {
        schemaVersion: 1,
        apps,
        settings: validateSettings(parsed.settings),
      };
      this.initialized = true;
      this.hasPersistedIndex = true;
    } catch (error) {
      // Keep the original index in place so a second launch cannot silently appear empty.
      const backupPath = `${this.indexPath}.corrupt-${Date.now()}-${randomUUID()}.bak`;
      await copyFile(this.indexPath, backupPath);
      throw new Error(
        `软件库索引无法读取，原文件未修改，备份位于 ${backupPath}。请修复或移走 library.json 后重试。原因：${errorMessage(error)}`,
      );
    }
  }

  getApps(): LibraryApp[] {
    this.assertReady();
    return structuredClone(this.state.apps);
  }

  getSettings(): Settings {
    this.assertReady();
    return { ...this.state.settings };
  }

  async saveSettings(settings: Settings): Promise<void> {
    this.assertReady();
    await this.commit({ ...this.state, settings: validateSettings(settings) });
  }

  /**
   * Adopt the app-managed devices without touching any Android device or APK cache.
   * Old installation associations remain recoverable in a separate index backup.
   * The main process serializes this migration with other library writes.
   */
  async adoptManagedSettings(settings: Settings): Promise<number> {
    this.assertReady();
    const normalized = validateSettings(settings);
    const next: Store = structuredClone(this.state);
    next.settings = normalized;
    let removed = 0;
    for (const app of next.apps) {
      for (const mode of ["phone", "tv"] as const) {
        const targetAvd =
          mode === "phone" ? normalized.phoneAvd : normalized.tvAvd;
        if (app.installed[mode] && app.installed[mode]!.avd !== targetAvd) {
          delete app.installed[mode];
          removed += 1;
        }
      }
    }
    const settingsChanged = (
      Object.keys(normalized) as (keyof Settings)[]
    ).some((key) => normalized[key] !== this.state.settings[key]);
    if (!settingsChanged && removed === 0) return 0;

    let original: Buffer | undefined;
    try {
      original = await readFile(this.indexPath);
    } catch (error) {
      // A fresh library has no index to preserve. Other backup failures abort migration.
      if (
        (error as NodeJS.ErrnoException).code !== "ENOENT" ||
        this.hasPersistedIndex
      )
        throw error;
    }
    if (original !== undefined) {
      const backupPath = `${this.indexPath}.before-managed-${Date.now()}-${randomUUID()}.bak`;
      const handle = await open(backupPath, "wx", 0o600);
      try {
        await handle.writeFile(original);
        await handle.sync();
      } catch (error) {
        await handle.close();
        await rm(backupPath, { force: true }).catch(() => {});
        throw error;
      }
      await handle.close();
    }
    // A failed commit leaves in-memory state and the original index unchanged;
    // the completed backup is deliberately retained for recovery.
    await this.commit(next);
    return removed;
  }

  getApp(id: string): LibraryApp {
    this.assertReady();
    const app = this.state.apps.find((entry) => entry.id === id);
    if (!app) throw new Error("软件不在软件库中，请刷新后重试。");
    return structuredClone(app);
  }

  getApkPath(id: string): string {
    return path.join(this.apkDirectory, `${this.getApp(id).id}.apk`);
  }

  async importApk(
    sourcePath: string,
    _legacyAaptPath?: string,
  ): Promise<{ app: LibraryApp; duplicate: boolean; replaced?: boolean }> {
    this.assertReady();
    if (
      typeof sourcePath !== "string" ||
      path.extname(sourcePath).toLowerCase() !== ".apk"
    ) {
      throw new Error("请选择 .apk 格式的 Android 安装包。");
    }
    const sourceInfo = await stat(sourcePath);
    if (
      !sourceInfo.isFile() ||
      sourceInfo.size < 4 ||
      sourceInfo.size > MAX_APK_BYTES
    ) {
      throw new Error("APK 必须是有效文件，大小不超过 4 GB。");
    }
    const temporaryPath = path.join(
      this.apkDirectory,
      `${randomUUID()}.tmp.apk`,
    );
    let newCachePath: string | undefined;
    try {
      await copyFile(sourcePath, temporaryPath);
      await chmod(temporaryPath, 0o600);
      const fileInfo = await stat(temporaryPath);
      if (fileInfo.size > MAX_APK_BYTES)
        throw new Error("APK 大小不超过 4 GB。");
      const handle = await open(temporaryPath, "r");
      try {
        const signature = Buffer.alloc(4);
        await handle.read(signature, 0, 4, 0);
        if (!signature.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
          throw new Error("文件不是有效的 APK / ZIP 安装包。");
        }
      } finally {
        await handle.close();
      }

      const id = await sha256(temporaryPath);
      const duplicate = this.state.apps.find((entry) => entry.id === id);
      if (duplicate) {
        // Re-import also repairs a cache copy that was removed or changed outside the app.
        await rename(temporaryPath, path.join(this.apkDirectory, `${id}.apk`));
        return { app: structuredClone(duplicate), duplicate: true };
      }

      let metadata: ApkMetadata;
      try {
        metadata = await readApkMetadata(temporaryPath);
      } catch (error) {
        throw new Error(
          `无法解析 APK，请检查安装包完整性。${errorMessage(error).slice(0, 1200)}`,
        );
      }
      const previous = this.state.apps.find(
        (entry) => entry.packageName === metadata.packageName,
      );
      const app: LibraryApp = {
        ...metadata,
        id,
        fileName: path.basename(sourcePath),
        size: fileInfo.size,
        importedAt: new Date().toISOString(),
        installed: {},
      };
      newCachePath = path.join(this.apkDirectory, `${id}.apk`);
      await rename(temporaryPath, newCachePath);
      await this.commit({
        ...this.state,
        apps: [
          app,
          ...this.state.apps.filter(
            (entry) => entry.packageName !== app.packageName,
          ),
        ],
      });
      newCachePath = undefined;
      if (previous)
        await rm(path.join(this.apkDirectory, `${previous.id}.apk`), {
          force: true,
        }).catch(() => {});
      return {
        app: structuredClone(app),
        duplicate: false,
        replaced: Boolean(previous),
      };
    } catch (error) {
      if (newCachePath) await rm(newCachePath, { force: true }).catch(() => {});
      throw error;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async markInstalled(
    id: string,
    mode: DeviceMode,
    avd: string,
  ): Promise<void> {
    this.assertMode(mode);
    if (!avd || typeof avd !== "string")
      throw new Error("安装记录缺少虚拟设备名称。");
    const app = this.getApp(id);
    app.installed[mode] = { avd, installedAt: new Date().toISOString() };
    await this.replaceApp(app);
  }

  async markUninstalled(id: string, mode: DeviceMode): Promise<void> {
    this.assertMode(mode);
    const app = this.getApp(id);
    delete app.installed[mode];
    await this.replaceApp(app);
  }

  async removeApp(id: string): Promise<void> {
    const apkPath = this.getApkPath(id);
    await this.commit({
      ...this.state,
      apps: this.state.apps.filter((entry) => entry.id !== id),
    });
    // A failed cache cleanup should not turn a committed removal into a reported failure.
    await rm(apkPath, { force: true }).catch(() => {});
  }

  private async replaceApp(app: LibraryApp): Promise<void> {
    await this.commit({
      ...this.state,
      apps: this.state.apps.map((entry) => (entry.id === app.id ? app : entry)),
    });
  }

  private assertReady(): void {
    if (!this.initialized) throw new Error("软件库尚未初始化。");
  }

  private assertMode(mode: DeviceMode): void {
    if (mode !== "phone" && mode !== "tv") throw new Error("无效的设备模式。");
  }

  private async commit(next: Store): Promise<void> {
    const temporaryPath = `${this.indexPath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporaryPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(next, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.indexPath);
      this.state = next;
      this.hasPersistedIndex = true;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }
}
