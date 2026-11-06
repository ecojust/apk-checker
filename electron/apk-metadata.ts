import yauzl from "yauzl";
import type { LibraryApp } from "../src/shared/types";

export type ApkMetadata = Pick<
  LibraryApp,
  | "name"
  | "packageName"
  | "versionName"
  | "versionCode"
  | "minSdk"
  | "launchableActivity"
  | "tvActivity"
>;
const ANDROID = "http://schemas.android.com/apk/res/android";
const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const LIMITS = {
  manifest: 8 * 1024 ** 2,
  resources: 64 * 1024 ** 2,
  entries: 100_000,
  strings: 500_000,
};
type Chunk = { start: number; header: number; end: number; type: number };
type ParseBudget = { decodedBytes: number; steps: number };
const newBudget = (): ParseBudget => ({ decodedBytes: 0, steps: 1_000_000 });
function spend(budget: ParseBudget): void {
  requireValid(--budget.steps >= 0, "APK 元数据过于复杂。");
}
type Value = {
  kind: "string" | "number" | "reference" | "boolean";
  value: string | number | boolean;
};
type Element = {
  name: string;
  attributes: Map<string, Value>;
  children: Element[];
};

function requireValid(
  condition: unknown,
  message = "APK 二进制元数据损坏。",
): asserts condition {
  if (!condition) throw new Error(message);
}
function chunkAt(data: Buffer, start: number, limit: number): Chunk {
  requireValid(start >= 0 && start + 8 <= limit && limit <= data.length);
  const header = data.readUInt16LE(start + 2);
  const size = data.readUInt32LE(start + 4);
  requireValid(header >= 8 && size >= header && size <= limit - start);
  return { start, header, end: start + size, type: data.readUInt16LE(start) };
}

function stringPool(data: Buffer, chunk: Chunk, budget: ParseBudget): string[] {
  requireValid(chunk.header >= 28);
  const count = data.readUInt32LE(chunk.start + 8);
  const styles = data.readUInt32LE(chunk.start + 12);
  const utf8 = (data.readUInt32LE(chunk.start + 16) & 0x100) !== 0;
  const stringsOffset = data.readUInt32LE(chunk.start + 20);
  const stylesOffset = data.readUInt32LE(chunk.start + 24);
  const stringsStart = chunk.start + stringsOffset;
  const stringsEnd = stylesOffset ? chunk.start + stylesOffset : chunk.end;
  requireValid(count <= LIMITS.strings && styles <= LIMITS.strings);
  requireValid(
    chunk.header + (count + styles) * 4 <= stringsOffset &&
      stringsStart <= stringsEnd &&
      stringsEnd <= chunk.end,
  );
  const result: string[] = [];
  const decoded = new Map<number, string>();
  for (let index = 0; index < count; index++) {
    spend(budget);
    let cursor =
      stringsStart + data.readUInt32LE(chunk.start + chunk.header + index * 4);
    const stringOffset = cursor;
    const existing = decoded.get(stringOffset);
    if (existing !== undefined) {
      result.push(existing);
      continue;
    }
    const length8 = () => {
      requireValid(cursor < stringsEnd);
      const first = data[cursor++];
      if (!(first & 0x80)) return first;
      requireValid(cursor < stringsEnd);
      return ((first & 0x7f) << 8) | data[cursor++];
    };
    const length16 = () => {
      requireValid(cursor + 2 <= stringsEnd);
      const first = data.readUInt16LE(cursor);
      cursor += 2;
      if (!(first & 0x8000)) return first;
      requireValid(cursor + 2 <= stringsEnd);
      const second = data.readUInt16LE(cursor);
      cursor += 2;
      return (first & 0x7fff) * 65536 + second;
    };
    requireValid(cursor >= stringsStart && cursor < stringsEnd);
    let value: string;
    if (utf8) {
      length8();
      const bytes = length8();
      requireValid(
        bytes <= stringsEnd - cursor - 1 && data[cursor + bytes] === 0,
      );
      budget.decodedBytes += bytes;
      requireValid(
        budget.decodedBytes <= LIMITS.resources,
        "APK 字符串数据过大。",
      );
      value = data.toString("utf8", cursor, cursor + bytes);
    } else {
      const bytes = length16() * 2;
      requireValid(
        bytes <= stringsEnd - cursor - 2 &&
          data.readUInt16LE(cursor + bytes) === 0,
      );
      budget.decodedBytes += bytes;
      requireValid(
        budget.decodedBytes <= LIMITS.resources,
        "APK 字符串数据过大。",
      );
      value = data.toString("utf16le", cursor, cursor + bytes);
    }
    decoded.set(stringOffset, value);
    result.push(value);
  }
  return result;
}

function xmlDocument(data: Buffer, budget: ParseBudget): Element {
  const rootChunk = chunkAt(data, 0, data.length);
  requireValid(
    rootChunk.type === 3 && rootChunk.end === data.length,
    "AndroidManifest.xml 不是有效的 Android 二进制 XML。",
  );
  let strings: string[] = [];
  const stack: Element[] = [];
  let root: Element | undefined;
  let nodes = 0;
  const text = (index: number) => {
    requireValid(index < strings.length);
    return strings[index];
  };
  for (let offset = rootChunk.header; offset < rootChunk.end;) {
    spend(budget);
    const chunk = chunkAt(data, offset, rootChunk.end);
    if (chunk.type === 1) strings = stringPool(data, chunk, budget);
    else if (chunk.type === 0x0102) {
      requireValid(
        chunk.header >= 16 && chunk.start + chunk.header + 20 <= chunk.end,
      );
      const ext = chunk.start + chunk.header;
      const count = data.readUInt16LE(ext + 12);
      const attributeStart = ext + data.readUInt16LE(ext + 8);
      const attributeSize = data.readUInt16LE(ext + 10);
      requireValid(
        attributeSize >= 20 &&
          attributeStart >= ext + 20 &&
          count * attributeSize <= chunk.end - attributeStart,
      );
      requireValid(
        ++nodes <= LIMITS.entries && stack.length < 256,
        "APK Manifest 节点过多或嵌套过深。",
      );
      const node: Element = {
        name: text(data.readUInt32LE(ext + 4)),
        attributes: new Map(),
        children: [],
      };
      requireValid(node.name.length <= 1024, "APK Manifest 节点名称过长。");
      for (let n = 0; n < count; n++) {
        spend(budget);
        const at = attributeStart + n * attributeSize;
        const namespaceIndex = data.readUInt32LE(at);
        const namespace =
          namespaceIndex === 0xffffffff ? "" : text(namespaceIndex);
        const name = text(data.readUInt32LE(at + 4));
        requireValid(
          namespace.length <= 2048 && name.length <= 1024,
          "APK Manifest 属性名称过长。",
        );
        const type = data[at + 15];
        const raw = data.readUInt32LE(at + 16);
        requireValid(data.readUInt16LE(at + 12) === 8);
        const value: Value =
          type === 3
            ? { kind: "string", value: text(raw) }
            : type === 1
              ? { kind: "reference", value: raw }
              : type === 0x12
                ? { kind: "boolean", value: raw !== 0 }
                : { kind: "number", value: raw };
        const key = `${namespace}:${name}`;
        budget.decodedBytes += key.length * 2;
        requireValid(
          budget.decodedBytes <= LIMITS.resources,
          "APK 字符串数据过大。",
        );
        requireValid(!node.attributes.has(key), "APK Manifest 含有重复属性。");
        node.attributes.set(key, value);
      }
      if (stack.length) stack[stack.length - 1].children.push(node);
      else {
        requireValid(!root, "APK Manifest 含有多个根节点。");
        root = node;
      }
      stack.push(node);
    } else if (chunk.type === 0x0103) {
      requireValid(
        chunk.header >= 16 && chunk.start + chunk.header + 8 <= chunk.end,
      );
      const name = text(data.readUInt32LE(chunk.start + chunk.header + 4));
      requireValid(stack.pop()?.name === name, "APK Manifest 节点未正确闭合。");
    }
    offset = chunk.end;
  }
  requireValid(
    root?.name === "manifest" && stack.length === 0,
    "APK 缺少有效的 manifest 根节点。",
  );
  return root;
}

function createResourceResolver(data: Buffer, budget: ParseBudget) {
  const table = chunkAt(data, 0, data.length);
  requireValid(
    table.type === 2 && table.header >= 12 && table.end === data.length,
    "APK resources.arsc 资源表损坏。",
  );
  let strings: string[] = [];
  const packages: Chunk[] = [];
  for (let at = table.header; at < table.end;) {
    spend(budget);
    const chunk = chunkAt(data, at, table.end);
    if (chunk.type === 1) strings = stringPool(data, chunk, budget);
    if (chunk.type === 0x0200) packages.push(chunk);
    at = chunk.end;
  }
  const types = new Map<number, Chunk[]>();
  for (const pkg of packages) {
    requireValid(pkg.header >= 284);
    const packageId = data.readUInt32LE(pkg.start + 8);
    requireValid(packageId <= 0xff);
    const typeIdOffset =
      pkg.header >= 288 ? data.readUInt32LE(pkg.start + 284) : 0;
    for (let at = pkg.start + pkg.header; at < pkg.end;) {
      spend(budget);
      const chunk = chunkAt(data, at, pkg.end);
      at = chunk.end;
      if (chunk.type !== 0x0201) continue;
      requireValid(chunk.header >= 28);
      const typeId = data[chunk.start + 8] + typeIdOffset;
      requireValid(typeId > 0 && typeId <= 0xff);
      const key = (packageId << 8) | typeId;
      const chunks = types.get(key) || [];
      chunks.push(chunk);
      types.set(key, chunks);
    }
  }
  const cached = new Map<number, string | undefined>();
  const resolve = (
    resourceId: number,
    visited = new Set<number>(),
  ): string | undefined => {
    if (cached.has(resourceId)) return cached.get(resourceId);
    if (visited.size >= 8 || visited.has(resourceId)) return undefined;
    visited.add(resourceId);
    let selected: { rank: number; type: number; data: number } | undefined;
    for (const chunk of types.get(resourceId >>> 16) || []) {
      spend(budget);
      const flags = data[chunk.start + 9];
      const count = data.readUInt32LE(chunk.start + 12);
      const entriesStart = chunk.start + data.readUInt32LE(chunk.start + 16);
      const configSize = data.readUInt32LE(chunk.start + 20);
      requireValid(
        configSize >= 4 &&
          configSize <= chunk.header - 20 &&
          count <= LIMITS.strings,
      );
      const width = flags & 2 ? 2 : 4;
      const indexes = chunk.start + chunk.header;
      requireValid(
        count * width <= entriesStart - indexes && entriesStart <= chunk.end,
      );
      const entryIndex = resourceId & 0xffff;
      let entryOffset: number | undefined;
      if (flags & 1) {
        requireValid(!(flags & 2));
        for (let n = 0; n < count; n++) {
          spend(budget);
          if (data.readUInt16LE(indexes + n * 4) === entryIndex) {
            entryOffset = data.readUInt16LE(indexes + n * 4 + 2) * 4;
            break;
          }
        }
      } else if (entryIndex < count) {
        const raw =
          width === 2
            ? data.readUInt16LE(indexes + entryIndex * 2)
            : data.readUInt32LE(indexes + entryIndex * 4);
        if (raw !== (width === 2 ? 0xffff : 0xffffffff))
          entryOffset = raw * (width === 2 ? 4 : 1);
      }
      if (entryOffset === undefined) continue;
      const entry = entriesStart + entryOffset;
      requireValid(entry >= entriesStart && entry + 8 <= chunk.end);
      const entryFlags = data.readUInt16LE(entry + 2);
      if (entryFlags & 1) continue;
      let valueType: number;
      let valueData: number;
      if (entryFlags & 8) {
        valueType = entryFlags >>> 8;
        valueData = data.readUInt32LE(entry + 4);
      } else {
        const size = data.readUInt16LE(entry);
        requireValid(
          size >= 8 &&
            entry + size + 8 <= chunk.end &&
            data.readUInt16LE(entry + size) >= 8,
        );
        valueType = data[entry + size + 3];
        valueData = data.readUInt32LE(entry + size + 4);
      }
      if (valueType !== 1 && valueType !== 3) continue;
      const language =
        configSize >= 12
          ? data
              .toString("ascii", chunk.start + 28, chunk.start + 30)
              .replace(/\0/g, "")
          : "";
      const country =
        configSize >= 12
          ? data
              .toString("ascii", chunk.start + 30, chunk.start + 32)
              .replace(/\0/g, "")
          : "";
      const script =
        configSize >= 40
          ? data
              .toString("ascii", chunk.start + 56, chunk.start + 60)
              .replace(/\0/g, "")
          : "";
      const rank =
        language === "zh"
          ? country === "CN" || script === "Hans"
            ? 4
            : 3
          : language === ""
            ? 2
            : 1;
      if (!selected || rank > selected.rank)
        selected = { rank, type: valueType, data: valueData };
    }
    let value: string | undefined;
    if (selected?.type === 1) value = resolve(selected.data, visited);
    else if (selected) {
      requireValid(selected.data < strings.length, "APK 字符串资源索引损坏。");
      value = strings[selected.data];
    }
    cached.set(resourceId, value);
    return value;
  };
  return resolve;
}

/** Resolve only the referenced string. Unsupported value types safely fall back. */
export function resourceString(
  data: Buffer,
  resourceId: number,
): string | undefined {
  return createResourceResolver(data, newBudget())(resourceId);
}

export function parseApkMetadata(
  manifest: Buffer,
  resources?: Buffer,
): ApkMetadata {
  requireValid(
    manifest.length <= LIMITS.manifest &&
      (!resources || resources.length <= LIMITS.resources),
    "APK 元数据超过大小限制。",
  );
  const budget = newBudget();
  const root = xmlDocument(manifest, budget);
  let resolveResource: ReturnType<typeof createResourceResolver> | undefined;
  const attr = (node: Element | undefined, name: string, namespace = ANDROID) =>
    node?.attributes.get(`${namespace}:${name}`);
  const string = (value?: Value): string | undefined => {
    if (!value) return undefined;
    if (value.kind === "reference") {
      if (!resources) return undefined;
      resolveResource ||= createResourceResolver(resources, budget);
      return resolveResource(Number(value.value));
    }
    return String(value.value);
  };
  const packageName = string(attr(root, "package", ""));
  requireValid(
    packageName && PACKAGE.test(packageName),
    "无法读取 APK 包名，请确认这是完整、有效的 APK 文件。",
  );
  const versionCode = string(attr(root, "versionCode"));
  requireValid(
    versionCode && /^\d+$/.test(versionCode),
    "APK 缺少有效的版本编号。",
  );
  const application = root.children.find((node) => node.name === "application");
  const activity = (category: string): string | undefined => {
    if (attr(application, "enabled")?.value === false) return undefined;
    for (const node of application?.children || []) {
      if (
        !["activity", "activity-alias"].includes(node.name) ||
        attr(node, "enabled")?.value === false ||
        attr(node, "exported")?.value === false
      )
        continue;
      const launcher = node.children.some(
        (filter) =>
          filter.name === "intent-filter" &&
          filter.children.some(
            (child) =>
              child.name === "action" &&
              string(attr(child, "name")) === "android.intent.action.MAIN",
          ) &&
          filter.children.some(
            (child) =>
              child.name === "category" &&
              string(attr(child, "name")) === category,
          ),
      );
      const name = string(attr(node, "name"));
      if (launcher && name)
        return name.startsWith(".")
          ? `${packageName}${name}`
          : name.includes(".")
            ? name
            : `${packageName}.${name}`;
    }
    return undefined;
  };
  return {
    packageName,
    name: (string(attr(application, "label")) || packageName).slice(0, 1024),
    versionName: string(attr(root, "versionName")) || versionCode,
    versionCode,
    minSdk: string(
      attr(
        root.children.find((node) => node.name === "uses-sdk"),
        "minSdkVersion",
      ),
    ),
    launchableActivity: activity("android.intent.category.LAUNCHER"),
    tvActivity: activity("android.intent.category.LEANBACK_LAUNCHER"),
  };
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Stream only bounded metadata from the archive; never extract APK paths to disk. */
export async function readApkMetadata(apkPath: string): Promise<ApkMetadata> {
  const files = await new Promise<Map<string, Buffer>>((resolve, reject) => {
    yauzl.open(
      apkPath,
      {
        lazyEntries: true,
        autoClose: false,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) => {
        if (error || !zip) {
          reject(error || new Error("无法读取 APK ZIP 文件。"));
          return;
        }
        const found = new Map<string, Buffer>();
        let finished = false;
        let entries = 0;
        const fail = (reason: unknown) => {
          if (finished) return;
          finished = true;
          zip.close();
          reject(reason);
        };
        zip.on("error", fail);
        zip.on("entry", (entry: yauzl.Entry) => {
          const load = async () => {
            requireValid(++entries <= LIMITS.entries, "APK 包含过多文件。");
            requireValid(
              !entry.fileName.split("/").includes("..") &&
                !entry.fileName.includes("\\") &&
                !entry.fileName.includes("\0") &&
                !/^(?:\/|[A-Za-z]:)/.test(entry.fileName),
              "APK 包含不安全的文件路径。",
            );
            const maximum =
              entry.fileName === "AndroidManifest.xml"
                ? LIMITS.manifest
                : entry.fileName === "resources.arsc"
                  ? LIMITS.resources
                  : 0;
            if (!maximum) {
              zip.readEntry();
              return;
            }
            requireValid(
              !found.has(entry.fileName),
              "APK 包含重复的元数据文件。",
            );
            requireValid(
              entry.uncompressedSize <= maximum &&
                !(entry.generalPurposeBitFlag & 1),
              "APK 元数据过大或经过加密。",
            );
            const stream = await new Promise<NodeJS.ReadableStream>(
              (accept, decline) =>
                zip.openReadStream(entry, (streamError, value) =>
                  streamError || !value ? decline(streamError) : accept(value),
                ),
            );
            const pieces: Buffer[] = [];
            let bytes = 0;
            try {
              for await (const piece of stream) {
                const buffer = Buffer.from(piece);
                bytes += buffer.length;
                requireValid(
                  bytes <= maximum,
                  "APK 解压后的元数据超过大小限制。",
                );
                pieces.push(buffer);
              }
            } catch (streamError) {
              (stream as NodeJS.ReadableStream & { destroy(): void }).destroy();
              throw streamError;
            }
            const data = Buffer.concat(pieces, bytes);
            requireValid(
              bytes === entry.uncompressedSize && crc32(data) === entry.crc32,
              "APK 元数据校验失败，文件可能已损坏。",
            );
            found.set(entry.fileName, data);
            zip.readEntry();
          };
          void load().catch(fail);
        });
        zip.once("end", () => {
          if (finished) return;
          finished = true;
          zip.close();
          resolve(found);
        });
        zip.readEntry();
      },
    );
  });
  const manifest = files.get("AndroidManifest.xml");
  requireValid(manifest, "APK 缺少 AndroidManifest.xml。");
  return parseApkMetadata(manifest, files.get("resources.arsc"));
}
