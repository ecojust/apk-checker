import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  downloadArchive,
  parseOptions,
  resolveBundleFiles,
  validateArchive,
} from "../scripts/prepare-runtime.mjs";

const catalog = JSON.parse(
  await readFile(
    new URL("../resources/runtime-catalog.json", import.meta.url),
    "utf8",
  ),
);
const temporaryDirectories = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const directory of temporaryDirectories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("pinned managed runtime catalog", () => {
  it.each(["darwin-arm64", "darwin-x64", "win32-x64", "linux-x64"])(
    "has native core and images for %s without silently shipping SDK images",
    (target) => {
      const [platform, arch] = target.split("-");
      const selected = resolveBundleFiles(catalog, platform, arch);
      expect(
        selected.components.map((component) => component.destination),
      ).toEqual(["sdk/platform-tools", "scrcpy"]);
      const specification = catalog.platforms[target];
      const expectedAbi = arch === "arm64" ? "arm64-v8a" : "x86_64";
      for (const image of Object.values(specification.images)) {
        expect(image.abi).toBe(expectedAbi);
        expect(image.stripPrefix).toBe(`${expectedAbi}/`);
        expect(image.destination).toContain(`/${image.tag}/${expectedAbi}`);
        expect(image.bundle).toBe(false);
        expect(image.licenseIds.length).toBeGreaterThan(0);
        expect(image.requiredFiles).toContain("system.img");
        expect(image.requiredFiles).toContain("ramdisk.img");
      }
      expect(specification.images.phone.tag).toBe("google_apis");
      expect(specification.images.tv.tag).toBe("android-tv");
      const emulator = specification.components.find(
        (component) => component.destination === "sdk/emulator",
      );
      expect(emulator.bundle).toBe(false);
      if (platform === "darwin" && arch === "arm64")
        expect(emulator.url).toContain("darwin_aarch64");
    },
  );

  it("budgets measured expanded archives, including TV images larger than eight GiB", () => {
    for (const platform of Object.values(catalog.platforms)) {
      for (const component of [
        ...platform.components,
        ...Object.values(platform.images),
      ]) {
        expect(Number.isSafeInteger(component.unpackedSize)).toBe(true);
        expect(component.unpackedSize).toBeGreaterThan(0);
        expect(component.unpackedSize).toBeLessThanOrEqual(
          component.maxExtractedBytes,
        );
      }
      expect(platform.images.phone.unpackedSize).toBeGreaterThan(3 * 1024 ** 3);
      expect(platform.images.tv.unpackedSize).toBeGreaterThan(8 * 1024 ** 3);
      // The real TV images expand beyond the old compressed-size multiplier.
      expect(platform.images.tv.unpackedSize).toBeGreaterThan(
        platform.images.tv.size * 4,
      );
    }
  });

  it("preserves the exact displayed license text and its fingerprint", async () => {
    for (const license of Object.values(catalog.licenses)) {
      const content = await readFile(
        new URL(`../resources/${license.file}`, import.meta.url),
        "utf8",
      );
      expect(content).toBe(license.text);
      expect(createHash("sha256").update(content).digest("hex")).toBe(
        license.sha256,
      );
      expect(content).toContain(
        "2.1 In order to use the SDK, you must first agree",
      );
    }
    for (const platform of Object.values(catalog.platforms)) {
      for (const component of [
        ...platform.components,
        ...Object.values(platform.images),
      ]) {
        for (const id of component.licenseIds)
          expect(catalog.licenses[id]).toBeDefined();
      }
    }
  });

  it("rejects an unsupported architecture instead of downloading another platform", () => {
    expect(() => resolveBundleFiles(catalog, "win32", "arm64")).toThrow(
      "Unsupported runtime target",
    );
  });

  it("rejects unsafe output names and unofficial archive sources", () => {
    const unsafe = structuredClone(catalog);
    unsafe.platforms["linux-x64"].components[0].bundledFile =
      "archives/../../escape.zip";
    expect(() => resolveBundleFiles(unsafe, "linux", "x64")).toThrow(
      "archive path",
    );
    unsafe.platforms["linux-x64"].components[0] = {
      ...catalog.platforms["linux-x64"].components[0],
      url: "https://example.com/runtime.zip",
    };
    expect(() => resolveBundleFiles(unsafe, "linux", "x64")).toThrow(
      "official HTTPS source",
    );
    unsafe.platforms["linux-x64"].components[0] = {
      ...catalog.platforms["linux-x64"].components[0],
      mirrors: ["https://mirrors.cloud.tencent.com/unverified-runtime.zip"],
    };
    expect(() => resolveBundleFiles(unsafe, "linux", "x64")).toThrow(
      "verified Android SDK archive path",
    );
  });

  it("falls back to a mirror after a corrupt download and verifies its original digest", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "apk-runtime-download-"),
    );
    temporaryDirectories.push(directory);
    const archive = Buffer.from("verified archive");
    const component = {
      id: "fixture",
      url: "https://dl.google.com/android/repository/fixture.zip",
      mirrors: ["https://mirrors.cloud.tencent.com/AndroidSDK/fixture.zip"],
      size: archive.length,
      checksum: {
        algorithm: "sha256",
        value: createHash("sha256").update(archive).digest("hex"),
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(Buffer.alloc(archive.length, 0)))
      .mockResolvedValueOnce(new Response(archive));
    vi.stubGlobal("fetch", fetchMock);
    const destination = path.join(directory, "archive.zip");
    await downloadArchive(component, destination);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      component.url,
      ...component.mirrors,
    ]);
    expect(await validateArchive(destination, component)).toBe(true);
  });

  it("does not trust cached archives with modified contents or size", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "apk-runtime-catalog-"),
    );
    temporaryDirectories.push(directory);
    const file = path.join(directory, "archive.zip");
    const original = Buffer.from("pinned core archive");
    const component = {
      size: original.length,
      checksum: {
        algorithm: "sha256",
        value: createHash("sha256").update(original).digest("hex"),
      },
    };
    expect(await validateArchive(file, component)).toBe(false);
    await writeFile(file, original);
    expect(await validateArchive(file, component)).toBe(true);
    await writeFile(file, Buffer.alloc(original.length, 0));
    expect(await validateArchive(file, component)).toBe(false);
    await writeFile(file, original.subarray(0, -1));
    expect(await validateArchive(file, component)).toBe(false);
  });

  it("requires explicit values for build target overrides", () => {
    expect(
      parseOptions(["--platform", "darwin", "--arch", "arm64", "--dry-run"]),
    ).toMatchObject({ platform: "darwin", arch: "arm64", dryRun: true });
    expect(() => parseOptions(["--arch", "--dry-run"])).toThrow(
      "Missing value",
    );
    expect(() => parseOptions(["--include-google-images"])).toThrow(
      "Unknown argument",
    );
  });
});
