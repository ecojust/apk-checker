import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import {
  parseApkMetadata,
  readApkMetadata,
  resourceString,
} from "../electron/apk-metadata";

const ANDROID = "http://schemas.android.com/apk/res/android";
function chunk(type: number, header: Buffer, body: Buffer): Buffer {
  const value = Buffer.alloc(8 + header.length + body.length);
  value.writeUInt16LE(type, 0);
  value.writeUInt16LE(8 + header.length, 2);
  value.writeUInt32LE(value.length, 4);
  header.copy(value, 8);
  body.copy(value, 8 + header.length);
  return value;
}
function pool(strings: string[], utf8 = true): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt32LE(strings.length, 0);
  header.writeUInt32LE(utf8 ? 0x100 : 0, 8);
  header.writeUInt32LE(28 + strings.length * 4, 12);
  const offsets = Buffer.alloc(strings.length * 4);
  let offset = 0;
  const encoded = strings.map((text, index) => {
    offsets.writeUInt32LE(offset, index * 4);
    const body = Buffer.from(text, utf8 ? "utf8" : "utf16le");
    const lengths = utf8
      ? Buffer.from([text.length, body.length])
      : Buffer.from([text.length, 0]);
    const value = Buffer.concat([lengths, body, Buffer.alloc(utf8 ? 1 : 2)]);
    offset += value.length;
    return value;
  });
  const all = Buffer.concat([offsets, ...encoded]);
  return chunk(
    1,
    header,
    Buffer.concat([all, Buffer.alloc((4 - (all.length % 4)) % 4)]),
  );
}
type Attribute = {
  name: string;
  value: string | number | boolean;
  type?: number;
  plain?: boolean;
};
type Node = { name: string; attributes?: Attribute[]; children?: Node[] };
function manifest(
  options: {
    labelReference?: boolean;
    version?: number;
    package?: string;
    disabled?: boolean;
    applicationDisabled?: boolean;
    exported?: boolean;
    alias?: boolean;
  } = {},
): Buffer {
  const root: Node = {
    name: "manifest",
    attributes: [
      {
        name: "package",
        value: options.package || "com.example.player",
        plain: true,
      },
      { name: "versionCode", value: options.version || 12 },
      { name: "versionName", value: "1.2" },
    ],
    children: [
      { name: "uses-sdk", attributes: [{ name: "minSdkVersion", value: 23 }] },
      {
        name: "application",
        attributes: [
          {
            name: "label",
            value: options.labelReference ? 0x7f010000 : "测试播放器",
            type: options.labelReference ? 1 : 3,
          },
          ...(options.applicationDisabled
            ? [{ name: "enabled", value: false }]
            : []),
        ],
        children: [
          {
            name: options.alias ? "activity-alias" : "activity",
            attributes: [
              { name: "name", value: ".MainActivity" },
              ...(options.disabled ? [{ name: "enabled", value: false }] : []),
              ...(options.exported === false
                ? [{ name: "exported", value: false }]
                : []),
            ],
            children: [
              {
                name: "intent-filter",
                children: [
                  {
                    name: "action",
                    attributes: [
                      { name: "name", value: "android.intent.action.MAIN" },
                    ],
                  },
                  {
                    name: "category",
                    attributes: [
                      {
                        name: "name",
                        value: "android.intent.category.LAUNCHER",
                      },
                    ],
                  },
                  {
                    name: "category",
                    attributes: [
                      {
                        name: "name",
                        value: "android.intent.category.LEANBACK_LAUNCHER",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const strings = [ANDROID];
  const add = (value: string) => {
    if (!strings.includes(value)) strings.push(value);
    return strings.indexOf(value);
  };
  const collect = (node: Node) => {
    add(node.name);
    for (const attr of node.attributes || []) {
      add(attr.name);
      if (typeof attr.value === "string") add(attr.value);
    }
    node.children?.forEach(collect);
  };
  collect(root);
  const encode = (node: Node): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(1, 0);
    header.writeUInt32LE(0xffffffff, 4);
    const extension = Buffer.alloc(20);
    extension.writeUInt32LE(0xffffffff, 0);
    extension.writeUInt32LE(add(node.name), 4);
    extension.writeUInt16LE(20, 8);
    extension.writeUInt16LE(20, 10);
    extension.writeUInt16LE(node.attributes?.length || 0, 12);
    const attributes = (node.attributes || []).map((attr) => {
      const value = Buffer.alloc(20);
      value.writeUInt32LE(attr.plain ? 0xffffffff : add(ANDROID), 0);
      value.writeUInt32LE(add(attr.name), 4);
      value.writeUInt32LE(0xffffffff, 8);
      value.writeUInt16LE(8, 12);
      value[15] =
        attr.type ??
        (typeof attr.value === "string"
          ? 3
          : typeof attr.value === "boolean"
            ? 0x12
            : 0x10);
      value.writeUInt32LE(
        typeof attr.value === "string" ? add(attr.value) : Number(attr.value),
        16,
      );
      return value;
    });
    const end = Buffer.alloc(8);
    end.writeUInt32LE(0xffffffff, 0);
    end.writeUInt32LE(add(node.name), 4);
    return Buffer.concat([
      chunk(0x0102, header, Buffer.concat([extension, ...attributes])),
      ...(node.children || []).map(encode),
      chunk(0x0103, header, end),
    ]);
  };
  return chunk(
    3,
    Buffer.alloc(0),
    Buffer.concat([pool(strings), encode(root)]),
  );
}

function resourceTable(
  options: {
    format?: "dense" | "sparse" | "offset16" | "compact";
    utf8?: boolean;
    targetIndex?: number;
    alias?: boolean;
    globalPool?: Buffer;
  } = {},
): Buffer {
  const target = options.targetIndex || 0;
  const format = options.format || "dense";
  const global =
    options.globalPool ||
    pool(["Default player", "中文播放器"], options.utf8 !== false);
  const type = (textIndex: number, locale = ""): Buffer => {
    const header = Buffer.alloc(76); // ResTable_type + 64-byte ResTable_config.
    header[0] = 1;
    header[1] = format === "sparse" ? 1 : format === "offset16" ? 2 : 0;
    const count = format === "sparse" ? 1 : target + 1;
    header.writeUInt32LE(count, 4);
    const indexes = Buffer.alloc(count * (format === "offset16" ? 2 : 4), 0xff);
    if (format === "sparse") {
      indexes.writeUInt16LE(target, 0);
      indexes.writeUInt16LE(0, 2);
    } else if (format === "offset16") indexes.writeUInt16LE(0, target * 2);
    else indexes.writeUInt32LE(0, target * 4);
    const padding = Buffer.alloc((4 - (indexes.length % 4)) % 4);
    header.writeUInt32LE(84 + indexes.length + padding.length, 8);
    header.writeUInt32LE(64, 12);
    if (locale) {
      header.write("zh", 20, "ascii");
      header.write(locale, 22, "ascii");
    }
    const valueType = options.alias ? 1 : 3;
    const valueData = options.alias ? 0x7f010000 + target : textIndex;
    const entry = Buffer.alloc(format === "compact" ? 8 : 16);
    if (format === "compact") {
      entry.writeUInt16LE(8 | (valueType << 8), 2);
      entry.writeUInt32LE(valueData, 4);
    } else {
      entry.writeUInt16LE(8, 0);
      entry.writeUInt16LE(8, 8);
      entry[11] = valueType;
      entry.writeUInt32LE(valueData, 12);
    }
    return chunk(0x0201, header, Buffer.concat([indexes, padding, entry]));
  };
  const packageHeader = Buffer.alloc(280);
  packageHeader.writeUInt32LE(0x7f, 0);
  const pkg = chunk(
    0x0200,
    packageHeader,
    Buffer.concat([type(0), type(1, "CN")]),
  );
  const tableHeader = Buffer.alloc(4);
  tableHeader.writeUInt32LE(1);
  return chunk(2, tableHeader, Buffer.concat([global, pkg]));
}

function checksum(buffer: Buffer): number {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}
function zip(
  files: {
    name: string;
    data: Buffer;
    deflate?: boolean;
    size?: number;
    badCrc?: boolean;
  }[],
): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const body = file.deflate ? deflateRawSync(file.data) : file.data;
    const crc = file.badCrc ? 0 : checksum(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(file.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(file.size ?? file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(file.deflate ? 8 : 0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(body.length, 20);
    directory.writeUInt32LE(file.size ?? file.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    central.push(directory, name);
    offset += local.length + name.length + body.length;
  }
  const table = Buffer.concat(central);
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50);
  footer.writeUInt16LE(files.length, 8);
  footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(table.length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, table, footer]);
}

describe("embedded Android binary metadata", () => {
  it("reads a compiled manifest with Unicode labels and both launch categories", () => {
    expect(parseApkMetadata(manifest())).toEqual({
      name: "测试播放器",
      packageName: "com.example.player",
      versionName: "1.2",
      versionCode: "12",
      minSdk: "23",
      launchableActivity: "com.example.player.MainActivity",
      tvActivity: "com.example.player.MainActivity",
    });
  });
  it("resolves compiled Chinese resource labels without SDK binaries", () => {
    expect(
      parseApkMetadata(manifest({ labelReference: true }), resourceTable())
        .name,
    ).toBe("中文播放器");
  });
  it.each(["dense", "sparse", "offset16", "compact"] as const)(
    "supports %s resource indexes and entries",
    (format) => {
      const targetIndex = format === "sparse" ? 5 : 0;
      expect(
        resourceString(
          resourceTable({ format, targetIndex }),
          0x7f010000 + targetIndex,
        ),
      ).toBe("中文播放器");
    },
  );
  it("reads UTF-16 resource pools and stops cyclic resource references", () => {
    expect(resourceString(resourceTable({ utf8: false }), 0x7f010000)).toBe(
      "中文播放器",
    );
    expect(
      resourceString(resourceTable({ alias: true }), 0x7f010000),
    ).toBeUndefined();
  });
  it("supports launcher aliases but does not report disabled activities as launchers", () => {
    expect(parseApkMetadata(manifest({ alias: true })).launchableActivity).toBe(
      "com.example.player.MainActivity",
    );
    expect(
      parseApkMetadata(manifest({ disabled: true })).launchableActivity,
    ).toBeUndefined();
    expect(
      parseApkMetadata(manifest({ applicationDisabled: true }))
        .launchableActivity,
    ).toBeUndefined();
    expect(
      parseApkMetadata(manifest({ exported: false })).launchableActivity,
    ).toBeUndefined();
  });
  it("bounds overlapping string amplification while sharing duplicate offsets", () => {
    const count = 2048;
    const characters = 32766;
    const header = Buffer.alloc(20);
    header.writeUInt32LE(count);
    header.writeUInt32LE(28 + count * 4, 12);
    const offsets = Buffer.alloc(count * 4);
    const bytes = Buffer.alloc(characters * 2 + count * 2 + 4);
    for (let index = 0; index < count; index++) {
      offsets.writeUInt32LE(index * 2, index * 4);
      bytes.writeUInt16LE(characters, index * 2);
    }
    const table = () =>
      resourceTable({
        globalPool: chunk(1, header, Buffer.concat([offsets, bytes])),
      });
    expect(() => resourceString(table(), 0x7f010000)).toThrow("字符串数据过大");
    offsets.fill(0);
    expect(resourceString(table(), 0x7f010000)).toHaveLength(characters);
  });
  it("rejects invalid package identifiers and malformed zero-sized chunks", () => {
    expect(() =>
      parseApkMetadata(manifest({ package: "com.app;reboot" })),
    ).toThrow("包名");
    const broken = manifest();
    broken.writeUInt32LE(0, 12);
    expect(() => parseApkMetadata(broken)).toThrow("损坏");
  });
  it("rejects resource offsets outside the bounded resource chunk", () => {
    const broken = resourceTable();
    broken.writeUInt32LE(0xffffffff, 32);
    expect(() => resourceString(broken, 0x7f010000)).toThrow();
  });
});

describe("bounded APK archive reading", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "embedded-apk-"));
  });
  afterEach(async () => {
    await rm(directory, { force: true, recursive: true });
  });
  async function read(files: Parameters<typeof zip>[0]) {
    const file = join(directory, "fixture.apk");
    await writeFile(file, zip(files));
    return readApkMetadata(file);
  }
  it("streams deflated manifest and resource metadata from a real ZIP", async () => {
    const result = await read([
      {
        name: "AndroidManifest.xml",
        data: manifest({ labelReference: true }),
        deflate: true,
      },
      { name: "resources.arsc", data: resourceTable(), deflate: true },
      {
        name: "assets/unread.bin",
        data: Buffer.from("does not need extraction"),
      },
    ]);
    expect(result).toMatchObject({
      name: "中文播放器",
      packageName: "com.example.player",
    });
  });
  it("rejects missing manifests and duplicate metadata entries", async () => {
    await expect(
      read([{ name: "assets/file", data: Buffer.alloc(0) }]),
    ).rejects.toThrow("AndroidManifest.xml");
    await expect(
      read([
        { name: "AndroidManifest.xml", data: manifest() },
        { name: "AndroidManifest.xml", data: manifest() },
      ]),
    ).rejects.toThrow("重复");
  });
  it("rejects unsafe paths without extracting any APK file", async () => {
    await expect(
      read([
        { name: "../outside", data: Buffer.from("unsafe") },
        { name: "AndroidManifest.xml", data: manifest() },
      ]),
    ).rejects.toThrow();
  });
  it("rejects metadata beyond the declared bound before decompression", async () => {
    await expect(
      read([
        {
          name: "AndroidManifest.xml",
          data: manifest(),
          deflate: true,
          size: 9 * 1024 ** 2,
        },
      ]),
    ).rejects.toThrow("元数据过大");
  });
  it("verifies metadata CRC before binary parsing", async () => {
    await expect(
      read([{ name: "AndroidManifest.xml", data: manifest(), badCrc: true }]),
    ).rejects.toThrow("校验失败");
  });
});
