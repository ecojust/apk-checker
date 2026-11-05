import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import { ManagedRuntime, safeArchivePath, type RuntimeCatalog, type RuntimeComponent, type RuntimeImage } from "../electron/managed-runtime";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Real ZIP fixture; no mock extraction or filesystem success. */
function zip(files: { name: string; contents: string; mode?: number }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const contents = Buffer.from(file.contents);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(contents), 14);
    header.writeUInt32LE(contents.length, 18);
    header.writeUInt32LE(contents.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, contents);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50, 0);
    index.writeUInt16LE((3 << 8) | 20, 4);
    index.writeUInt16LE(20, 6);
    index.writeUInt32LE(crc32(contents), 16);
    index.writeUInt32LE(contents.length, 20);
    index.writeUInt32LE(contents.length, 24);
    index.writeUInt16LE(name.length, 28);
    index.writeUInt32LE(((file.mode || 0o100755) << 16) >>> 0, 38);
    index.writeUInt32LE(offset, 42);
    central.push(index, name);
    offset += header.length + name.length + contents.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

describe("managed emulator preparation", () => {
  let directory: string;
  let resources: string;
  let catalog: RuntimeCatalog;
  let payloads: Map<string, Buffer>;
  let fetcher: ReturnType<typeof vi.fn>;
  let manager: ManagedRuntime;

  function component(id: string, destination: string, files: string[], bundle = false): RuntimeComponent {
    const bytes = zip(files.map(name => ({ name: "package/" + name, contents: "fixture:" + name })));
    const url = "https://example.test/" + id + ".zip";
    payloads.set(url, bytes);
    return {
      id, label: id, destination, archive: "zip", stripPrefix: "package/", url, size: bytes.length,
      unpackedSize: files.reduce((size, name) => size + Buffer.byteLength("fixture:" + name), 0),
      checksum: { algorithm: "sha256", value: createHash("sha256").update(bytes).digest("hex") },
      executables: files.filter(file => !file.endsWith(".img") && file !== "scrcpy-server"),
      requiredFiles: files.filter(file => file.endsWith(".img") || file === "scrcpy-server"),
      primaryExecutable: files[0], licenseIds: ["test-license"],
      ...(bundle ? { bundledFile: "archives/" + id + ".zip" } : {}),
    };
  }
  function createManager(overrides: ConstructorParameters<typeof ManagedRuntime>[2] = {}) {
    return new ManagedRuntime(directory, resources, { platform: "linux", arch: "x64", catalog, fetch: fetcher as typeof fetch, checkDiskSpace: false, ...overrides });
  }

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "apk managed runtime "));
    resources = path.join(directory, "resources");
    payloads = new Map();
    await mkdir(path.join(resources, "licenses"), { recursive: true });
    await writeFile(path.join(resources, "licenses", "test.txt"), "Example runtime terms.");
    const components = [
      component("communication", "sdk/platform-tools", ["adb"], true),
      component("engine", "sdk/emulator", ["emulator"]),
      component("display", "scrcpy", ["scrcpy", "scrcpy-server"]),
    ];
    const phone: RuntimeImage = { ...component("phone-image", "sdk/system-images/android-30/google_apis/x86_64", ["system.img", "ramdisk.img"]), api: 30, abi: "x86_64", tag: "google_apis" };
    const tv: RuntimeImage = { ...component("tv-image", "sdk/system-images/android-36/android-tv/x86_64", ["system.img", "ramdisk.img"]), api: 36, abi: "x86_64", tag: "android-tv" };
    catalog = {
      schemaVersion: 1,
      licenses: { "test-license": { name: "Example terms", file: "licenses/test.txt" } },
      platforms: { "linux-x64": { components, images: { phone, tv } } },
    };
    fetcher = vi.fn(async (url: string) => {
      const payload = payloads.get(url);
      return new Response(payload ? new Uint8Array(payload) : "missing", { status: payload ? 200 : 404 });
    });
    manager = createManager();
  });
  afterEach(async () => {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  });

  it("does not download or create devices before explicit license acceptance", async () => {
    await expect(manager.prepare("phone", vi.fn())).rejects.toThrow("许可");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await manager.getStatus()).toMatchObject({ supported: true, licenseAccepted: false, phoneReady: false });
  });

  it("budgets the full ARM TV expansion and writable device space before downloading", async () => {
    const image = catalog.platforms["linux-x64"].images.tv;
    // The real ARM TV36 archive is only 970 MB but expands to over 8 GiB.
    image.unpackedSize = 8_741_340_272;
    manager = createManager({ checkDiskSpace: true, availableDiskBytes: async () => 12 * 1024 ** 3 });
    await manager.acceptLicense();
    await expect(manager.prepare("tv", vi.fn())).rejects.toThrow("当前可用 12.0 GB，至少需要 18.2 GB");
    expect(fetcher).not.toHaveBeenCalled();
    expect((await manager.getStatus()).tvReady).toBe(false);
  });

  it("uses the conservative extraction limit when exact unpacked size is unavailable", async () => {
    const image = catalog.platforms["linux-x64"].images.tv;
    delete image.unpackedSize;
    image.maxExtractedBytes = 12 * 1024 ** 3;
    manager = createManager({ checkDiskSpace: true, availableDiskBytes: async () => 20 * 1024 ** 3 });
    await manager.acceptLicense();
    await expect(manager.prepare("tv", vi.fn())).rejects.toThrow("磁盘空间不足");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reserves replacement staging while retaining old image files and installed applications", async () => {
    await manager.acceptLicense();
    const settings = await manager.prepare("phone", vi.fn());
    const image = catalog.platforms["linux-x64"].images.phone;
    image.unpackedSize = 2 * 1024 ** 3;
    const imageRoot = path.join(directory, "managed-runtime", image.destination);
    await rm(path.join(imageRoot, "system.img"));
    const data = path.join(manager.getEnvironment().ANDROID_AVD_HOME!, settings.phoneAvd + ".avd", "userdata-qemu.img");
    await writeFile(data, "installed applications");
    let available = 10.5 * 1024 ** 3;
    const repair = createManager({ checkDiskSpace: true, availableDiskBytes: async () => available });
    try {
      const calls = fetcher.mock.calls.length;
      await expect(repair.prepare("phone", vi.fn())).rejects.toThrow("至少需要 11.0 GB");
      expect(await readFile(path.join(imageRoot, "ramdisk.img"), "utf8")).toBe("fixture:ramdisk.img");
      expect(await readFile(data, "utf8")).toBe("installed applications");
      // The verified archive is already cached: exactly 2 GiB staging plus
      // 9 GiB device headroom is enough; its archive need not be charged again.
      available = 11 * 1024 ** 3;
      await repair.prepare("phone", vi.fn());
      expect(fetcher.mock.calls.length).toBe(calls);
      expect((await repair.getStatus()).phoneReady).toBe(true);
      available = 0;
      await expect(repair.prepare("phone", vi.fn())).resolves.toEqual(settings);
    } finally { await repair.dispose(); }
  });

  it("prepares real archives, persists readiness and isolates its SDK and AVD paths", async () => {
    await manager.acceptLicense();
    const settings = await manager.prepare("phone", vi.fn());
    expect(settings.phoneAvd).toBe("APKChecker_Phone_30_x86_64");
    expect(await readFile(path.join(settings.sdkPath, "platform-tools", "adb"), "utf8")).toBe("fixture:adb");
    const environment = manager.getEnvironment();
    expect(environment.ADB_SERVER_SOCKET).toMatch(/^tcp:localhost:\d+$/);
    expect(environment.ADB_SERVER_SOCKET).not.toBe("tcp:localhost:5037");
    expect(environment.ANDROID_AVD_HOME).toBe(path.join(directory, "managed-runtime", "avds"));
    const config = await readFile(path.join(environment.ANDROID_AVD_HOME!, settings.phoneAvd + ".avd", "config.ini"), "utf8");
    expect(config).toContain("tag.id=google_apis");
    expect(config).toContain("hw.lcd.width=1080");
    expect(await manager.getStatus()).toMatchObject({ coreReady: true, phoneReady: true, tvReady: false, licenseAccepted: true });
    const reopened = createManager();
    expect(await reopened.getStatus()).toMatchObject({ phoneReady: true, licenseAccepted: true });
    reopened.dispose();
  });

  it("uses verified bundled tools without downloading them and excludes them from download size", async () => {
    const tool = catalog.platforms["linux-x64"].components[0];
    const bundle = path.join(resources, "runtime-bundled", tool.bundledFile!);
    await mkdir(path.dirname(bundle), { recursive: true });
    await writeFile(bundle, payloads.get(tool.url)!);
    const total = [...catalog.platforms["linux-x64"].components.slice(1), catalog.platforms["linux-x64"].images.phone].reduce((sum, entry) => sum + entry.size, 0);
    expect((await manager.getStatus()).downloadBytes.phone).toBe(total);
    await manager.acceptLicense();
    await manager.prepare("phone", vi.fn());
    expect(fetcher.mock.calls.some(([url]) => url === tool.url)).toBe(false);
  });

  it("keeps application userdata and only prepares the missing TV image", async () => {
    await manager.acceptLicense();
    const settings = await manager.prepare("phone", vi.fn());
    const data = path.join(manager.getEnvironment().ANDROID_AVD_HOME!, settings.phoneAvd + ".avd", "userdata-qemu.img");
    await writeFile(data, "existing application data");
    const calls = fetcher.mock.calls.length;
    await manager.prepare("phone", vi.fn());
    expect(fetcher.mock.calls.length).toBe(calls);
    await manager.prepare("tv", vi.fn());
    expect(fetcher.mock.calls.length).toBe(calls + 1);
    expect(await readFile(data, "utf8")).toBe("existing application data");
    expect(await manager.getStatus()).toMatchObject({ phoneReady: true, tvReady: true });
  });

  it("keeps incompatible host architectures in separate virtual devices", async () => {
    await manager.acceptLicense();
    const intel = await manager.prepare("phone", vi.fn());
    const data = path.join(manager.getEnvironment().ANDROID_AVD_HOME!, intel.phoneAvd + ".avd", "userdata-qemu.img");
    await writeFile(data, "Intel applications");
    const arm = structuredClone(catalog.platforms["linux-x64"]);
    for (const image of Object.values(arm.images)) {
      image.abi = "arm64-v8a";
      image.destination = image.destination.replace("x86_64", "arm64-v8a");
    }
    catalog.platforms["darwin-arm64"] = arm;
    const apple = createManager({ platform: "darwin", arch: "arm64" });
    try {
      const settings = await apple.prepare("phone", vi.fn());
      expect(settings.phoneAvd).toBe("APKChecker_Phone_30_arm64_v8a");
      expect(settings.phoneAvd).not.toBe(intel.phoneAvd);
      expect(await readFile(data, "utf8")).toBe("Intel applications");
      const config = await readFile(path.join(apple.getEnvironment().ANDROID_AVD_HOME!, settings.phoneAvd + ".avd", "config.ini"), "utf8");
      expect(config).toContain("abi.type=arm64-v8a");
    } finally { await apple.dispose(); }
  });

  it("detects missing image contents and repairs them from a verified local archive", async () => {
    await manager.acceptLicense();
    await manager.prepare("phone", vi.fn());
    const image = catalog.platforms["linux-x64"].images.phone;
    await rm(path.join(directory, "managed-runtime", image.destination, "system.img"));
    expect((await manager.getStatus()).phoneReady).toBe(false);
    const calls = fetcher.mock.calls.length;
    await manager.prepare("phone", vi.fn());
    expect(fetcher.mock.calls.length).toBe(calls);
    expect((await manager.getStatus()).phoneReady).toBe(true);
  });

  it("rejects corrupt downloads and never commits executable or ready state", async () => {
    fetcher.mockImplementation(async () => new Response("tampered bytes"));
    await manager.acceptLicense();
    await expect(manager.prepare("phone", vi.fn())).rejects.toThrow("校验失败");
    expect((await manager.getStatus()).coreReady).toBe(false);
    expect(await stat(path.join(manager.getSettings().sdkPath, "platform-tools", "adb")).catch(() => null)).toBeNull();
  });

  it("resumes partial downloads with a validated byte range and final full checksum", async () => {
    const tool = catalog.platforms["linux-x64"].components[0];
    const bytes = payloads.get(tool.url)!;
    const downloads = path.join(directory, "managed-runtime", "downloads");
    await mkdir(downloads, { recursive: true });
    await writeFile(path.join(downloads, tool.id + ".zip.partial"), bytes.subarray(0, 20));
    fetcher.mockImplementation(async (url: string, options: RequestInit) => {
      if (url === tool.url) {
        expect(options.headers).toEqual({ Range: "bytes=20-" });
        return new Response(new Uint8Array(bytes.subarray(20)), { status: 206, headers: { "content-range": "bytes 20-" + (bytes.length - 1) + "/" + bytes.length } });
      }
      return new Response(new Uint8Array(payloads.get(url)!));
    });
    await manager.acceptLicense();
    await manager.prepare("phone", vi.fn());
    expect((await manager.getStatus()).phoneReady).toBe(true);
  });

  it("can cancel a blocked download, clear busy state and retry successfully", async () => {
    fetcher.mockImplementationOnce(async (_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }));
    await manager.acceptLicense();
    const attempt = manager.prepare("phone", vi.fn());
    const rejected = expect(attempt).rejects.toThrow("取消");
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled());
    manager.cancel();
    await rejected;
    expect((await manager.getStatus()).preparing).toBeUndefined();
    await manager.prepare("phone", vi.fn());
    expect((await manager.getStatus()).phoneReady).toBe(true);
  });

  it("acquires preparation ownership before any asynchronous initialization", async () => {
    await manager.acceptLicense();
    const first = manager.prepare("phone", vi.fn());
    await expect(manager.prepare("tv", vi.fn())).rejects.toThrow("正在准备");
    await first;
    expect((await manager.getStatus()).tvReady).toBe(false);
  });

  it("can cancel immediately and waits for cleanup when disposed", async () => {
    await manager.acceptLicense();
    const attempt = manager.prepare("phone", vi.fn());
    const rejected = expect(attempt).rejects.toThrow("取消");
    await manager.dispose();
    await rejected;
    expect(fetcher).not.toHaveBeenCalled();
    expect((await manager.getStatus()).preparing).toBeUndefined();
  });

  it("cleans abandoned extraction workspaces and restores interrupted component replacement", async () => {
    await manager.acceptLicense();
    const settings = await manager.prepare("phone", vi.fn());
    const root = path.join(directory, "managed-runtime");
    const data = path.join(manager.getEnvironment().ANDROID_AVD_HOME!, settings.phoneAvd + ".avd", "userdata-qemu.img");
    await writeFile(data, "preserve installed applications");
    const staging = path.join(root, "staging", "old-extraction");
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "partial-system.img"), "abandoned extraction");
    const tool = path.join(settings.sdkPath, "platform-tools");
    await rename(tool, tool + ".previous-interrupted");
    const reopened = createManager();
    try {
      await Promise.all([reopened.init(), reopened.init()]);
      const port = reopened.getEnvironment().ANDROID_ADB_SERVER_PORT;
      await reopened.init();
      expect(reopened.getEnvironment().ANDROID_ADB_SERVER_PORT).toBe(port);
      expect((await reopened.getStatus()).phoneReady).toBe(true);
      expect(await stat(staging).catch(() => null)).toBeNull();
      expect(await readFile(data, "utf8")).toBe("preserve installed applications");
    } finally { await reopened.dispose(); }
  });

  it("falls back from the official source to a mirror with the same pinned checksum", async () => {
    const tool = catalog.platforms["linux-x64"].components[0];
    const mirror = "https://mirror.example.test/communication.zip";
    tool.mirrors = [mirror];
    payloads.set(mirror, payloads.get(tool.url)!);
    payloads.delete(tool.url);
    await manager.acceptLicense();
    await manager.prepare("phone", vi.fn());
    expect(fetcher.mock.calls.slice(0, 2).map(([url]) => url)).toEqual([tool.url, mirror]);
    expect((await manager.getStatus()).phoneReady).toBe(true);
  });

  it("rejects a corrupt mirror and leaves no committed component or extraction stage", async () => {
    const tool = catalog.platforms["linux-x64"].components[0];
    tool.mirrors = ["https://mirror.example.test/communication.zip"];
    fetcher.mockImplementation(async (url: string) => url === tool.url ? new Response(null, { status: 503 }) : new Response("corrupt mirror bytes"));
    await manager.acceptLicense();
    await expect(manager.prepare("phone", vi.fn())).rejects.toThrow("校验失败");
    expect((await manager.getStatus()).coreReady).toBe(false);
    expect(await readdir(path.join(directory, "managed-runtime", "staging")).catch(() => [])).toEqual([]);
  });

  it("requires accepting changed license text again", async () => {
    await manager.acceptLicense();
    await writeFile(path.join(resources, "licenses", "test.txt"), "Changed terms.");
    expect((await manager.getStatus()).licenseAccepted).toBe(false);
    await expect(manager.prepare("phone", vi.fn())).rejects.toThrow("许可");
  });

  it("rejects a checksum-pinned ZIP containing an escaping symbolic link", async () => {
    const tool = catalog.platforms["linux-x64"].components[0];
    const bytes = zip([{ name: "package/adb", contents: "../../escaped", mode: 0o120777 }]);
    tool.size = bytes.length;
    tool.checksum.value = createHash("sha256").update(bytes).digest("hex");
    payloads.set(tool.url, bytes);
    await manager.acceptLicense();
    await expect(manager.prepare("phone", vi.fn())).rejects.toThrow("链接");
    expect((await manager.getStatus()).coreReady).toBe(false);
    expect(await stat(path.join(directory, "escaped")).catch(() => null)).toBeNull();
  });

  it.skipIf(process.platform === "win32").each(["direct", "symlinked"])("preserves safe tar.gz library symlinks with a %s user-data root", async rootType => {
    let userData = directory;
    if (rootType === "symlinked") {
      const canonicalData = path.join(directory, "canonical-user-data");
      userData = path.join(directory, "user-data-alias");
      await mkdir(canonicalData);
      await symlink(canonicalData, userData, "dir");
      manager = new ManagedRuntime(userData, resources, { platform: "linux", arch: "x64", catalog, fetch: fetcher as typeof fetch, checkDiskSpace: false });
    }
    const source = path.join(directory, "tar-source");
    await mkdir(path.join(source, "package"), { recursive: true });
    await writeFile(path.join(source, "package", "scrcpy"), "native display");
    await writeFile(path.join(source, "package", "scrcpy-server"), "server bytes");
    await writeFile(path.join(source, "package", "library.1"), "library bytes");
    await symlink("library.1", path.join(source, "package", "library"));
    const archive = path.join(directory, "fixture.tar.gz");
    await tar.c({ cwd: source, file: archive, gzip: true }, ["package"]);
    const bytes = await readFile(archive);
    const display = catalog.platforms["linux-x64"].components[2];
    display.archive = "tar.gz"; display.size = bytes.length;
    display.checksum.value = createHash("sha256").update(bytes).digest("hex");
    payloads.set(display.url, bytes);
    await manager.acceptLicense();
    await manager.prepare("phone", vi.fn());
    expect(await readFile(path.join(userData, "managed-runtime", "scrcpy", "library"), "utf8")).toBe("library bytes");
  });

  it("cancels during tar extraction without an uncaught process error or leftover staging", async () => {
    const source = path.join(directory, "cancel-source", "package");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "scrcpy"), "native display");
    await writeFile(path.join(source, "scrcpy-server"), "server bytes");
    const libraries = Array.from({ length: 64 }, (_, index) => "library-" + index);
    await Promise.all(libraries.map(name => writeFile(path.join(source, name), Buffer.alloc(64 * 1024, 120))));
    const archive = path.join(directory, "cancellation.tar.gz");
    await tar.c({ cwd: path.dirname(source), file: archive, gzip: true }, ["package/scrcpy", "package/scrcpy-server", ...libraries.map(name => "package/" + name)]);
    const bytes = await readFile(archive);
    const display = catalog.platforms["linux-x64"].components[2];
    display.archive = "tar.gz"; display.size = bytes.length;
    display.checksum.value = createHash("sha256").update(bytes).digest("hex");
    catalog.platforms["linux-x64"].components = [display];
    const metadata = path.join(directory, "cancellation-catalog.json");
    await writeFile(metadata, JSON.stringify(catalog));
    const script = path.join(directory, "cancel-extraction.mts");
    await writeFile(script, `
      import { ManagedRuntime } from ${JSON.stringify(pathToFileURL(path.resolve("electron/managed-runtime.ts")).href)};
      import { readFile, readdir, stat } from 'node:fs/promises';
      import path from 'node:path';
      const catalog = JSON.parse(await readFile(${JSON.stringify(metadata)}, 'utf8'));
      const manager = new ManagedRuntime(${JSON.stringify(directory)}, ${JSON.stringify(resources)}, {
        platform:'linux', arch:'x64', catalog, checkDiskSpace:false,
        fetch: async () => new Response(new Uint8Array(await readFile(${JSON.stringify(archive)}))),
      });
      await manager.acceptLicense();
      const staging = path.join(${JSON.stringify(directory)}, 'managed-runtime', 'staging');
      let cancelled = false;
      const monitor = setInterval(async () => {
        const entries = await readdir(staging).catch(() => []);
        for (const name of entries) if (await stat(path.join(staging, name, 'scrcpy')).catch(() => null)) {
          cancelled = true;
          manager.cancel();
        }
      }, 1);
      try {
        await manager.prepare('phone', () => {});
        throw Error('Preparation was not cancelled during extraction');
      } catch (error) {
        if (!cancelled || !error.message.includes('取消')) throw error;
      } finally {
        clearInterval(monitor);
        await manager.dispose();
      }
      if ((await readdir(staging)).length) throw Error('Extraction staging was not cleaned');
      process.stdout.write('cancelled and cleaned');
    `);
    const child = await promisify(execFile)(process.execPath, ["--import", "tsx", script], { timeout: 15_000 });
    expect(child.stdout).toBe("cancelled and cleaned");
  }, 20_000);

  it.each(["../outside", "/absolute", "C:\\Windows\\x", "safe/../../outside", "file:stream", "\\\\server\\share"])("rejects archive path %s on every host platform", name => {
    expect(() => safeArchivePath(name)).toThrow();
  });

  it("does not pretend an unsupported host can run the emulator", async () => {
    const unsupported = createManager({ platform: "win32", arch: "arm64" });
    expect(await unsupported.getStatus()).toMatchObject({ supported: false, phoneReady: false });
    await expect(unsupported.acceptLicense()).rejects.toThrow("暂不支持");
    unsupported.dispose();
  });
});
