import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, statfs, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as yauzl from "yauzl";
import * as tar from "tar";
import type { DeviceMode, ManagedRuntimeStatus, Settings } from "../src/shared/types";

export interface RuntimeComponent {
  id: string;
  label: string;
  url: string;
  mirrors?: string[];
  checksum: { algorithm: "sha1" | "sha256"; value: string };
  size: number;
  unpackedSize?: number;
  archive: "zip" | "tar.gz";
  stripPrefix?: string;
  destination: string;
  executables?: string[];
  primaryExecutable?: string;
  bundledFile?: string;
  licenseIds?: string[];
  maxExtractedBytes?: number;
  requiredFiles?: string[];
}
export interface RuntimeImage extends RuntimeComponent {
  api: number;
  tag: string;
  abi: string;
}
export interface RuntimeCatalog {
  schemaVersion: number;
  licenses?: Record<string, { name: string; file: string; url?: string; sha256?: string }>;
  platforms: Record<string, { components: RuntimeComponent[]; images: Record<DeviceMode, RuntimeImage> }>;
}
export type RuntimePreparationProgress = (message: string, completedBytes?: number, totalBytes?: number) => void;
interface ManagedOptions {
  platform?: string;
  arch?: string;
  catalog?: RuntimeCatalog;
  fetch?: typeof globalThis.fetch;
  /** Explicitly opt out only for tiny filesystem tests. Production checks disk space. */
  checkDiskSpace?: boolean;
  /** Storage adapter for deterministic low-space tests; production uses statfs. */
  availableDiskBytes?: (directory: string) => Promise<number>;
}

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
async function exists(file: string): Promise<boolean> {
  return Boolean(await stat(file).catch(() => null));
}

/** A path originating in a catalog/archive must remain relative on every host OS. */
export function safeArchivePath(value: string): string {
  if (value.includes("\0") || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) throw new Error("运行环境压缩包包含无效路径。");
  const parts = value.replaceAll("\\", "/").split("/").filter(part => part && part !== ".");
  if (parts.some(part => part === ".." || part.includes(":"))) throw new Error("运行环境压缩包包含越界路径。");
  return parts.join("/");
}

function entryRelative(name: string, prefix: string): string | undefined {
  const safe = safeArchivePath(name);
  const root = safeArchivePath(prefix);
  if (!root) return safe;
  if (safe === root) return "";
  return safe.startsWith(root + "/") ? safe.slice(root.length + 1) : undefined;
}

async function digest(file: string, algorithm: string): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function verified(file: string, component: RuntimeComponent): Promise<boolean> {
  const metadata = await stat(file).catch(() => null);
  return Boolean(metadata?.isFile() && metadata.size === component.size &&
    await digest(file, component.checksum.algorithm) === component.checksum.value);
}

/** No extraction write may traverse a symlink, including one left by an earlier entry. */
async function safeParents(root: string, relative: string): Promise<void> {
  const parts = relative.split("/").slice(0, -1);
  let directory = root;
  for (const part of parts) {
    directory = path.join(directory, part);
    const current = await lstat(directory).catch(() => null);
    if (current && (!current.isDirectory() || current.isSymbolicLink())) throw new Error("运行环境压缩包包含不安全的目录链接。");
    if (!current) await mkdir(directory, { mode: 0o700 });
  }
}

interface ArchiveLink { name: string; target: string; hard?: boolean }
async function installLinks(root: string, links: ArchiveLink[]): Promise<void> {
  // The user-data path may itself contain a system symlink (macOS /var maps
  // to /private/var). Resolve both sides of the final containment comparison.
  const canonicalRoot = await realpath(root);
  // Link creation is delayed until all regular file writes are finished.
  for (const link of links) {
    await safeParents(root, link.name);
    if (path.isAbsolute(link.target) || /^[A-Za-z]:/.test(link.target) || link.target.includes("\0") || link.target.includes("\\")) {
      throw new Error("运行环境压缩包包含不安全的文件链接。");
    }
    const target = path.resolve(link.hard ? root : path.dirname(path.join(root, link.name)), link.target);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error("运行环境文件链接超出解压目录。");
    if (link.hard) {
      const metadata = await lstat(target).catch(() => null);
      if (!metadata?.isFile() || metadata.isSymbolicLink()) throw new Error("运行环境硬链接的目标无效。");
      await copyFile(target, path.join(root, link.name));
    } else {
      await symlink(link.target, path.join(root, link.name));
    }
  }
  for (const link of links) {
    const resolved = await realpath(path.join(root, link.name));
    if (resolved !== canonicalRoot && !resolved.startsWith(canonicalRoot + path.sep)) throw new Error("运行环境文件链接超出解压目录。");
  }
}

async function unzip(file: string, directory: string, component: RuntimeComponent, signal: AbortSignal): Promise<void> {
  const archive = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, autoClose: false, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) reject(error || new Error("无法读取运行环境压缩包。"));
      else resolve(zip);
    });
  });
  const links: ArchiveLink[] = [];
  const names = new Set<string>();
  const limit = component.maxExtractedBytes || Math.min(16 * 1024 ** 3, Math.max(1024 ** 3, component.size * 40));
  let expanded = 0;
  let entries = 0;
  let pendingEntry: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => { archive.close(); reject(new Error("已取消模拟器准备。")); };
      signal.addEventListener("abort", onAbort, { once: true });
      archive.on("error", reject);
      archive.on("end", () => { signal.removeEventListener("abort", onAbort); resolve(); });
      archive.on("entry", (entry: yauzl.Entry) => {
        pendingEntry = (async () => {
          signal.throwIfAborted();
          if (++entries > 200_000) throw new Error("运行环境压缩包文件数量异常。");
          expanded += entry.uncompressedSize;
          if (!Number.isSafeInteger(expanded) || expanded > limit) throw new Error("运行环境解压大小超过安全限制。");
          const relative = entryRelative(entry.fileName, component.stripPrefix || "");
          if (!relative) { archive.readEntry(); return; }
          if (names.has(relative)) throw new Error("运行环境压缩包包含重复路径。");
          names.add(relative);
          const unixMode = entry.externalFileAttributes >>> 16;
          const kind = unixMode & 0o170000;
          const isDirectory = /\/$/.test(entry.fileName) || kind === 0o040000;
          const isLink = kind === 0o120000;
          if (kind && ![0o040000, 0o100000, 0o120000].includes(kind)) throw new Error("运行环境压缩包包含特殊设备文件。");
          await safeParents(directory, relative);
          const target = path.join(directory, relative);
          if (isDirectory) {
            await mkdir(target, { recursive: true, mode: 0o700 });
          } else {
            const input = await new Promise<Readable>((resolveStream, rejectStream) => {
              archive.openReadStream(entry, (error, stream) => {
                if (error || !stream) rejectStream(error || new Error("无法解压运行环境文件。"));
                else resolveStream(stream);
              });
            });
            if (isLink) {
              if (entry.uncompressedSize > 4096) throw new Error("运行环境文件链接过长。");
              const chunks: Buffer[] = [];
              for await (const chunk of input) chunks.push(Buffer.from(chunk));
              links.push({ name: relative, target: Buffer.concat(chunks).toString("utf8") });
            } else {
              await pipeline(input, createWriteStream(target, { flags: "wx", mode: unixMode & 0o777 || 0o600 }), { signal });
            }
          }
          archive.readEntry();
        })();
        void pendingEntry.catch(reject);
      });
      archive.readEntry();
    });
    signal.throwIfAborted();
    await installLinks(directory, links);
  } finally {
    archive.close();
    // An abort can arrive while a file pipeline is closing. Wait before the
    // caller removes staging (required for Windows open-file semantics).
    await pendingEntry?.catch(() => undefined);
  }
}

async function untar(file: string, directory: string, component: RuntimeComponent, signal: AbortSignal): Promise<void> {
  const links: ArchiveLink[] = [];
  const names = new Set<string>();
  const prefix = safeArchivePath(component.stripPrefix || "");
  const limit = component.maxExtractedBytes || Math.min(16 * 1024 ** 3, Math.max(1024 ** 3, component.size * 40));
  let expanded = 0;
  let entries = 0;
  let invalid: unknown;
  // tar's strict path protections stay enabled. Preflight rejects special files
  // and withholds links, so they cannot redirect regular-file extraction.
  await tar.t({
    file, strict: true,
    onReadEntry(entry) {
      if (invalid) return;
      try {
      signal.throwIfAborted();
      if (++entries > 200_000) throw new Error("运行环境压缩包文件数量异常。");
      expanded += entry.size;
      if (!Number.isSafeInteger(expanded) || expanded > limit) throw new Error("运行环境解压大小超过安全限制。");
      const relative = entryRelative(entry.path, prefix);
      if (!relative) return;
      if (names.has(relative)) throw new Error("运行环境压缩包包含重复路径。");
      names.add(relative);
      if (entry.type === "SymbolicLink" || entry.type === "Link") {
        if (!entry.linkpath) throw new Error("运行环境文件链接缺少目标。");
        links.push({ name: relative, target: entry.type === "Link" ? entryRelative(entry.linkpath, prefix) || "" : entry.linkpath, hard: entry.type === "Link" });
      } else if (!["File", "OldFile", "Directory"].includes(entry.type)) {
        throw new Error("运行环境压缩包包含特殊设备文件。");
      }
      } catch (error) { invalid = error; }
    },
  });
  if (invalid) throw invalid;
  signal.throwIfAborted();
  await tar.x({
    file, cwd: directory, strict: true, preservePaths: false, noMtime: true,
    strip: prefix ? prefix.split("/").length : 0,
    filter(name, entry) {
      // node-tar invokes filters from stream callbacks. Throwing here would
      // escape its promise and crash Electron, so stop accepting entries and
      // reject only after in-flight file writes have closed.
      if (signal.aborted) return false;
      return Boolean(entryRelative(name, prefix)) && "type" in entry && ["File", "OldFile", "Directory"].includes(entry.type);
    },
  });
  signal.throwIfAborted();
  await installLinks(directory, links);
}

/** The entire environment lives in userData, never in a system SDK or a real device. */
export class ManagedRuntime {
  private readonly root: string;
  private readonly platformKey: string;
  private readonly catalog?: RuntimeCatalog;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly options: ManagedOptions;
  private catalogError?: string;
  private preparation?: DeviceMode;
  private controller?: AbortController;
  private lastError?: string;
  private disposed = false;
  private privateAdbPort?: number;
  private initialization?: Promise<void>;
  private activePreparation?: Promise<Settings>;

  constructor(rootDir: string, private readonly resourcesDir: string, options: ManagedOptions = {}) {
    this.root = path.join(rootDir, "managed-runtime");
    this.options = options;
    this.platformKey = (options.platform || process.platform) + "-" + (options.arch || process.arch);
    this.fetcher = options.fetch || globalThis.fetch;
    try {
      this.catalog = options.catalog || JSON.parse(readFileSync(path.join(resourcesDir, "runtime-catalog.json"), "utf8"));
      if (this.catalog?.schemaVersion !== 1 || !this.catalog.platforms) throw new Error("内置模拟器目录格式无效。");
      const definition = this.catalog.platforms[this.platformKey];
      if (definition) for (const component of [...definition.components, ...Object.values(definition.images)]) this.validateComponent(component);
    } catch (error) { this.catalogError = errorMessage(error); }
  }

  init(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.initialization = (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      // Only extraction workspaces and catalog-owned component backups are
      // recoverable garbage. AVDs and resumable downloads are never removed.
      await rm(path.join(this.root, "staging"), { recursive: true, force: true });
      const definition = !this.catalogError && this.catalog?.platforms[this.platformKey];
      if (definition) for (const component of [...definition.components, ...Object.values(definition.images)]) {
        const destination = path.join(this.root, component.destination);
        const parent = path.dirname(destination);
        const prefix = path.basename(destination) + ".previous-";
        const backups = (await readdir(parent).catch(() => [])).filter(name => name.startsWith(prefix));
        // A crash between the two atomic renames must not discard the old copy.
        for (const backup of backups) {
          if (!await exists(destination)) await rename(path.join(parent, backup), destination);
          else await rm(path.join(parent, backup), { recursive: true, force: true });
        }
      }
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("无法分配模拟器内部通信端口。");
      this.privateAdbPort = address.port;
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    })();
    return this.initialization;
  }

  private validateComponent(component: RuntimeComponent): void {
    if (!SAFE_ID.test(component.id) || !Number.isSafeInteger(component.size) || component.size <= 0 ||
      !["zip", "tar.gz"].includes(component.archive) || !["sha1", "sha256"].includes(component.checksum.algorithm) ||
      !new RegExp("^[a-f0-9]{" + (component.checksum.algorithm === "sha256" ? 64 : 40) + "}$").test(component.checksum.value)) {
      throw new Error("内置模拟器资源信息无效。");
    }
    if ((component.unpackedSize !== undefined && (!Number.isSafeInteger(component.unpackedSize) || component.unpackedSize <= 0)) ||
      (component.maxExtractedBytes !== undefined && (!Number.isSafeInteger(component.maxExtractedBytes) || component.maxExtractedBytes <= 0)) ||
      (component.unpackedSize !== undefined && component.maxExtractedBytes !== undefined && component.unpackedSize > component.maxExtractedBytes)) {
      throw new Error("内置模拟器展开大小信息无效。");
    }
    for (const address of [component.url, ...component.mirrors || []]) {
      const url = new URL(address);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error("模拟器下载地址必须使用 HTTPS。");
    }
    if (!safeArchivePath(component.destination)) throw new Error("模拟器资源目录不能为空。");
    safeArchivePath(component.stripPrefix || "");
    if (component.bundledFile) safeArchivePath(component.bundledFile);
    for (const executable of component.executables || []) safeArchivePath(executable);
    for (const required of component.requiredFiles || []) safeArchivePath(required);
    if (component.primaryExecutable) safeArchivePath(component.primaryExecutable);
  }

  private definition() {
    const definition = !this.catalogError && this.catalog?.platforms[this.platformKey];
    if (!definition) throw new Error(this.catalogError || "当前系统暂不支持内置模拟器，请使用 Apple Silicon / Intel Mac 或 Windows x64。");
    return definition;
  }

  getSettings(defaultMode: DeviceMode = "phone"): Settings {
    const definition = this.catalog?.platforms[this.platformKey];
    const display = definition?.components.find(component => component.destination === "scrcpy");
    return {
      sdkPath: path.join(this.root, "sdk"),
      scrcpyPath: path.join(this.root, display?.destination || "scrcpy", display?.primaryExecutable || (this.platformKey.startsWith("win32") ? "scrcpy.exe" : "scrcpy")),
      phoneAvd: "APKChecker_Phone_" + (definition?.images.phone.api || 30) + "_" + (definition?.images.phone.abi || this.platformKey).replaceAll("-", "_"),
      tvAvd: "APKChecker_TV_" + (definition?.images.tv.api || 36) + "_" + (definition?.images.tv.abi || this.platformKey).replaceAll("-", "_"),
      defaultMode,
    };
  }

  getEnvironment(): NodeJS.ProcessEnv {
    if (!this.privateAdbPort) throw new Error("请先初始化内置模拟器。");
    const settings = this.getSettings();
    return {
      ANDROID_HOME: settings.sdkPath,
      ANDROID_SDK_ROOT: settings.sdkPath,
      ANDROID_AVD_HOME: path.join(this.root, "avds"),
      ANDROID_USER_HOME: path.join(this.root, "home"),
      ANDROID_EMULATOR_HOME: path.join(this.root, "home"),
      SCRCPY_SERVER_PATH: path.join(path.dirname(settings.scrcpyPath), "scrcpy-server"),
      // adb treats an explicit numeric host as remote and will not auto-start
      // a daemon. "localhost" retains local startup on this dedicated port.
      ADB_SERVER_SOCKET: "tcp:localhost:" + this.privateAdbPort,
      ANDROID_ADB_SERVER_PORT: String(this.privateAdbPort),
    };
  }

  async getLicense(): Promise<string> {
    const definition = this.definition();
    const ids = [...new Set([...definition.components, ...Object.values(definition.images)].flatMap(component => component.licenseIds || []))].sort();
    const texts: string[] = [];
    for (const id of ids) {
      const license = this.catalog?.licenses?.[id];
      if (!license) throw new Error("内置运行环境缺少许可文件，请重新安装客户端。");
      const file = path.join(this.resourcesDir, safeArchivePath(license.file));
      const contents = await readFile(file, "utf8");
      if (license.sha256 && createHash("sha256").update(contents).digest("hex") !== license.sha256) {
        throw new Error("运行环境许可文件校验失败，请重新安装客户端。");
      }
      texts.push(license.name + "\n" + (license.url || "") + "\n\n" + contents);
    }
    return texts.join("\n\n----------------------------------------\n\n");
  }

  private async licenseHash(): Promise<string> {
    return createHash("sha256").update(await this.getLicense()).digest("hex");
  }

  async acceptLicense(): Promise<void> {
    const hash = await this.licenseHash();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.root, "license-" + randomUUID() + ".tmp");
    await writeFile(temporary, JSON.stringify({ hash, acceptedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(temporary, path.join(this.root, "license.json"));
  }

  private async licenseAccepted(): Promise<boolean> {
    try {
      const record = JSON.parse(await readFile(path.join(this.root, "license.json"), "utf8"));
      return record.hash === await this.licenseHash();
    } catch { return false; }
  }

  private async componentReady(component: RuntimeComponent): Promise<boolean> {
    const destination = path.join(this.root, component.destination);
    try {
      const receipt = JSON.parse(await readFile(path.join(destination, ".apk-checker-component.json"), "utf8"));
      if (receipt.id !== component.id || receipt.checksum !== component.checksum.value) return false;
      for (const executable of [...component.executables || [], ...component.requiredFiles || []]) {
        const info = await stat(path.join(destination, executable));
        if (!info.isFile()) return false;
      }
      return true;
    } catch { return false; }
  }

  async getStatus(): Promise<ManagedRuntimeStatus> {
    const fallback: ManagedRuntimeStatus = { supported: false, coreReady: false, phoneReady: false, tvReady: false, licenseAccepted: false, downloadBytes: { phone: 0, tv: 0 }, preparing: this.preparation, error: this.lastError };
    try {
      const definition = this.definition();
      const core = await Promise.all(definition.components.map(component => this.componentReady(component)));
      const coreReady = core.every(Boolean);
      const settings = this.getSettings();
      const ready = await Promise.all((["phone", "tv"] as const).map(async mode =>
        coreReady && await this.componentReady(definition.images[mode]) &&
        await exists(path.join(this.root, "avds", (mode === "phone" ? settings.phoneAvd : settings.tvAvd) + ".avd", "config.ini"))));
      const remainingCore = (await Promise.all(definition.components.map(component => this.remainingDownload(component)))).reduce((sum, size) => sum + size, 0);
      return {
        ...fallback, supported: true, coreReady, phoneReady: ready[0], tvReady: ready[1], licenseAccepted: await this.licenseAccepted(),
        downloadBytes: {
          phone: remainingCore + await this.remainingDownload(definition.images.phone),
          tv: remainingCore + await this.remainingDownload(definition.images.tv),
        },
      };
    } catch (error) { return { ...fallback, error: errorMessage(error) }; }
  }

  private async remainingDownload(component: RuntimeComponent): Promise<number> {
    if (await this.componentReady(component)) return 0;
    if (component.bundledFile && await exists(path.join(this.resourcesDir, "runtime-bundled", component.bundledFile))) return 0;
    const file = path.join(this.root, "downloads", component.id + "." + component.archive);
    if ((await stat(file).catch(() => null))?.size === component.size) return 0;
    const partial = (await stat(file + ".partial").catch(() => null))?.size || 0;
    return Math.max(0, component.size - partial);
  }

  private async archive(component: RuntimeComponent, progress: RuntimePreparationProgress, signal: AbortSignal): Promise<string> {
    if (component.bundledFile) {
      const bundled = path.join(this.resourcesDir, "runtime-bundled", component.bundledFile);
      if (await exists(bundled)) {
        progress("正在校验内置" + component.label + "…");
        if (!await verified(bundled, component)) throw new Error("内置" + component.label + "校验失败，请重新下载安装包。");
        return bundled;
      }
    }
    const directory = path.join(this.root, "downloads");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, component.id + "." + component.archive);
    if (await verified(file, component)) return file;
    await rm(file, { force: true });
    const addresses = [component.url, ...component.mirrors || []];
    let failure: unknown;
    for (let index = 0; index < addresses.length; index++) {
      signal.throwIfAborted();
      if (index) progress("正在切换下载线路，继续准备" + component.label + "…");
      try { return await this.download(component, addresses[index], file, progress, signal); }
      catch (error) { failure = error; signal.throwIfAborted(); }
    }
    throw failure;
  }

  private async download(component: RuntimeComponent, address: string, file: string, progress: RuntimePreparationProgress, signal: AbortSignal): Promise<string> {
    const partial = file + ".partial";
    let offset = (await stat(partial).catch(() => null))?.size || 0;
    if (offset === component.size && await verified(partial, component)) {
      await rename(partial, file); return file;
    }
    if (offset >= component.size) { await rm(partial, { force: true }); offset = 0; }
    progress("正在下载" + component.label + "…", offset, component.size);
    const idle = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => idle.abort(new Error("下载暂时没有响应，请检查网络后重试。")), 60_000);
    };
    resetTimer();
    const downloadSignal = AbortSignal.any([signal, idle.signal]);
    try {
      const response = await this.fetcher(address, {
        signal: downloadSignal,
        headers: offset ? { Range: "bytes=" + offset + "-" } : {},
      });
      if (!response.ok || !response.body) throw new Error("下载" + component.label + "失败（HTTP " + response.status + "），请检查网络后重试。");
      if (response.url && !response.url.startsWith("https:")) throw new Error("模拟器资源下载被重定向到不安全的地址。");
      if (offset && response.status === 206) {
        const range = response.headers.get("content-range");
        if (!range?.startsWith("bytes " + offset + "-") || !range.endsWith("/" + component.size)) throw new Error("下载服务器返回了错误的续传范围，请重试。");
      } else {
        if (response.status === 206) throw new Error("下载服务器返回了不完整的资源。");
        offset = 0;
      }
      const handle = await open(partial, offset ? "a" : "w", 0o600);
      let received = offset;
      let lastUpdate = 0;
      try {
        const input = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
        for await (const chunk of input) {
          downloadSignal.throwIfAborted();
          resetTimer();
          received += chunk.length;
          if (received > component.size) throw new Error("下载资源大小与内置目录不符。");
          await handle.writeFile(chunk);
          if (Date.now() - lastUpdate >= 250 || received === component.size) {
            progress("正在下载" + component.label + "…", received, component.size);
            lastUpdate = Date.now();
          }
        }
      } finally { await handle.close(); }
      signal.throwIfAborted();
      progress("正在校验" + component.label + "…");
      if (!await verified(partial, component)) {
        await rm(partial, { force: true });
        throw new Error(component.label + "下载校验失败，请重试。");
      }
      await rename(partial, file);
      return file;
    } finally { clearTimeout(timer!); }
  }

  private async installComponent(component: RuntimeComponent, progress: RuntimePreparationProgress, signal: AbortSignal): Promise<void> {
    if (await this.componentReady(component)) return;
    const archive = await this.archive(component, progress, signal);
    signal.throwIfAborted();
    const staging = path.join(this.root, "staging", component.id + "-" + randomUUID());
    const destination = path.join(this.root, component.destination);
    const backup = destination + ".previous-" + randomUUID();
    await mkdir(staging, { recursive: true, mode: 0o700 });
    let previous = false;
    let committed = false;
    try {
      progress("正在展开" + component.label + "…");
      if (component.archive === "zip") await unzip(archive, staging, component, signal);
      else await untar(archive, staging, component, signal);
      for (const executable of component.executables || []) {
        const executablePath = path.join(staging, executable);
        const info = await stat(executablePath).catch(() => null);
        if (!info?.isFile()) throw new Error(component.label + "缺少必要文件，请重试。");
        if (!this.platformKey.startsWith("win32")) await chmod(executablePath, info.mode | 0o755);
      }
      for (const required of component.requiredFiles || []) {
        if (!(await stat(path.join(staging, required)).catch(() => null))?.isFile()) {
          throw new Error(component.label + "缺少必要文件，请重试。");
        }
      }
      signal.throwIfAborted();
      await writeFile(path.join(staging, ".apk-checker-component.json"), JSON.stringify({ id: component.id, checksum: component.checksum.value }), { mode: 0o600 });
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      if (await exists(destination)) { await rename(destination, backup); previous = true; }
      try { await rename(staging, destination); committed = true; }
      catch (error) { if (previous) await rename(backup, destination); throw error; }
      if (previous) await rm(backup, { recursive: true, force: true });
    } finally {
      if (!committed) await rm(staging, { recursive: true, force: true });
    }
  }

  private async createAvd(mode: DeviceMode): Promise<void> {
    const image = this.definition().images[mode];
    const settings = this.getSettings(mode);
    const name = mode === "phone" ? settings.phoneAvd : settings.tvAvd;
    const home = path.join(this.root, "avds");
    const directory = path.join(home, name + ".avd");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, "home"), { recursive: true, mode: 0o700 });
    const values: Record<string, string> = {
      "AvdId": name, "avd.ini.displayname": mode === "phone" ? "APK Checker Phone" : "APK Checker TV",
      "abi.type": image.abi, "hw.cpu.arch": image.abi === "arm64-v8a" ? "arm64" : image.abi,
      "hw.cpu.ncore": "4", "hw.device.name": mode === "phone" ? "pixel_2" : "tv_1080p",
      "hw.lcd.width": mode === "phone" ? "1080" : "1920", "hw.lcd.height": mode === "phone" ? "1920" : "1080",
      "hw.lcd.density": mode === "phone" ? "420" : "240", "hw.ramSize": mode === "phone" ? "2048" : "3072",
      "hw.gpu.enabled": "yes", "hw.gpu.mode": "auto", "hw.keyboard": "yes",
      "hw.mainKeys": mode === "phone" ? "no" : "yes", "hw.audioInput": "yes", "hw.audioOutput": "yes",
      "hw.camera.back": "none", "hw.camera.front": "none",
      "disk.dataPartition.size": "6G", "vm.heapSize": "256",
      "tag.id": image.tag, "tag.display": mode === "phone" ? "Google APIs" : "Android TV",
      "image.sysdir.1": path.join(this.root, image.destination) + path.sep,
      "showDeviceFrame": "no", "fastboot.forceColdBoot": "no",
    };
    const config = path.join(directory, "config.ini");
    // Never replace an existing AVD or its userdata images during repeat setup.
    if (!await exists(config)) {
      await writeFile(config, Object.entries(values).map(([key, value]) => key + "=" + value).join("\n") + "\n", { mode: 0o600, flag: "wx" });
    }
    await writeFile(path.join(home, name + ".ini"), "avd.ini.encoding=UTF-8\npath=" + directory + "\ntarget=android-" + image.api + "\n", { mode: 0o600 });
  }

  private async checkStorage(mode: DeviceMode): Promise<void> {
    if (this.options.checkDiskSpace === false) return;
    const definition = this.definition();
    const components = [...definition.components, definition.images[mode]];
    let required = 0;
    let needsPreparation = false;
    for (const component of components) {
      if (await this.componentReady(component)) continue;
      needsPreparation = true;
      // The previous component stays on disk until its replacement commits.
      // Charge a full new staging copy; do not credit its eventual deletion.
      required += component.unpackedSize ?? component.maxExtractedBytes ?? 16 * 1024 ** 3;
      // Cached/bundled archives already occupy space on their own volumes.
      // Downloaded archives stay cached, so reserve every remaining byte too.
      required += await this.remainingDownload(component);
    }
    const settings = this.getSettings(mode);
    const avd = mode === "phone" ? settings.phoneAvd : settings.tvAvd;
    if (!await exists(path.join(this.root, "avds", avd + ".avd", "config.ini"))) needsPreparation = true;
    if (!needsPreparation) return;
    // 6 GiB writable app/data partition, one RAM-sized snapshot, and 1 GiB
    // for writable image metadata, logs and filesystem overhead. This is free
    // space headroom; it does not preallocate or replace existing user data.
    required += (6 + (mode === "phone" ? 2 : 3) + 1) * 1024 ** 3;
    const available = this.options.availableDiskBytes
      ? await this.options.availableDiskBytes(this.root)
      : await statfs(this.root).then(disk => disk.bavail * disk.bsize);
    if (!Number.isFinite(available) || available < 0) throw new Error("无法确认模拟器可用磁盘空间，请检查应用数据目录后重试。");
    if (available < required) {
      const availableGb = (Math.floor(available / 1024 ** 3 * 10) / 10).toFixed(1);
      const requiredGb = (Math.ceil(required / 1024 ** 3 * 10) / 10).toFixed(1);
      throw new Error("磁盘空间不足：当前可用 " + availableGb + " GB，至少需要 " + requiredGb + " GB（包含展开文件、下载缓存和模拟器运行空间）。请释放空间后重试。");
    }
  }

  prepare(mode: DeviceMode, progress: RuntimePreparationProgress): Promise<Settings> {
    if (mode !== "phone" && mode !== "tv") return Promise.reject(new Error("无效的模拟器模式。"));
    if (this.disposed) return Promise.reject(new Error("应用正在退出，准备已取消。"));
    if (this.preparation) return Promise.reject(new Error("正在准备模拟器，请稍候。"));
    // Acquire ownership synchronously, before initialization or license I/O.
    this.preparation = mode;
    this.lastError = undefined;
    const controller = this.controller = new AbortController();
    const task = this.runPreparation(mode, progress, controller);
    this.activePreparation = task;
    return task;
  }

  private async runPreparation(mode: DeviceMode, progress: RuntimePreparationProgress, controller: AbortController): Promise<Settings> {
    try {
      const definition = this.definition();
      await this.init();
      controller.signal.throwIfAborted();
      if (!await this.licenseAccepted()) throw new Error("请先阅读并同意运行环境许可，然后准备模拟器。");
      controller.signal.throwIfAborted();
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.checkStorage(mode);
      for (const component of [...definition.components, definition.images[mode]]) {
        controller.signal.throwIfAborted();
        await this.installComponent(component, progress, controller.signal);
      }
      controller.signal.throwIfAborted();
      await this.createAvd(mode);
      progress((mode === "phone" ? "手机" : "电视") + "模拟器已准备好。");
      return this.getSettings(mode);
    } catch (error) {
      this.lastError = controller.signal.aborted ? "已取消模拟器准备，可稍后继续。" : errorMessage(error);
      throw new Error(this.lastError);
    } finally {
      this.preparation = undefined;
      this.controller = undefined;
    }
  }

  cancel(): void { this.controller?.abort(new Error("用户取消了模拟器准备。")); }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancel();
    // Electron's shutdown handler can await extraction rollback before exit.
    await this.activePreparation?.catch(() => undefined);
  }
}
