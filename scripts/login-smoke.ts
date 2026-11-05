import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";

export interface LoginProbeContext {
  artifacts: string;
  avd: string;
  shell(...args: string[]): Promise<string>;
  command(file: string, args: string[], timeout?: number): Promise<string>;
  screenshot(file: string): Promise<void>;
  rotateNativeDisplay?(): Promise<void>;
}
type Rectangle = { x: number; y: number; width: number; height: number };
type HostWindow = Rectangle & { id: number; title: string };
type HostCapture = {
  image: string;
  width: number;
  height: number;
  windows: HostWindow[];
  window: HostWindow;
  capturedAt: string;
};

export function publishProbeDiagnostic(title: string, value: unknown): void {
  if (!process.env.GITHUB_ACTIONS) return;
  const encoded = JSON.stringify(value);
  const emit = (message: string) => console.log(
    `::notice title=${title}::${message.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`,
  );
  if (Buffer.byteLength(encoded, "utf8") <= 3500) {
    emit(encoded);
    return;
  }
  const base64 = Buffer.from(encoded, "utf8").toString("base64");
  const total = Math.ceil(base64.length / 2800);
  const diagnosticId = `${title}:${Date.now()}`;
  for (let index = 0; index < total; index++)
    emit(JSON.stringify({ type: "probe-diagnostic-fragment", diagnosticId,
      title, index, total, dataBase64Chunk: base64.slice(index * 2800, (index + 1) * 2800) }));
}

// Xvfb is private to this CI job. Capture its actual primary display using only
// Python's standard library + X11 already required by the native emulator.
// No screen-capture protection is changed in Android or in the supplied APK.
const X11_CAPTURE = String.raw`
import ctypes as C, ctypes.util, json, struct, sys, zlib
X = C.CDLL(ctypes.util.find_library('X11'))
D = C.c_void_p
W = C.c_ulong
class Attributes(C.Structure):
    _fields_ = [('x',C.c_int),('y',C.c_int),('width',C.c_int),('height',C.c_int),('border_width',C.c_int),('depth',C.c_int),('visual',D),('root',W),('cls',C.c_int),('bit_gravity',C.c_int),('win_gravity',C.c_int),('backing_store',C.c_int),('backing_planes',C.c_ulong),('backing_pixel',C.c_ulong),('save_under',C.c_int),('colormap',C.c_ulong),('map_installed',C.c_int),('map_state',C.c_int),('all_event_masks',C.c_long),('your_event_mask',C.c_long),('do_not_propagate_mask',C.c_long),('override_redirect',C.c_int),('screen',D)]
class Image(C.Structure):
    _fields_ = [('width',C.c_int),('height',C.c_int),('xoffset',C.c_int),('format',C.c_int),('data',D),('byte_order',C.c_int),('bitmap_unit',C.c_int),('bitmap_bit_order',C.c_int),('bitmap_pad',C.c_int),('depth',C.c_int),('bytes_per_line',C.c_int),('bits_per_pixel',C.c_int),('red_mask',C.c_ulong),('green_mask',C.c_ulong),('blue_mask',C.c_ulong)]
X.XOpenDisplay.argtypes=[C.c_char_p]; X.XOpenDisplay.restype=D
X.XDefaultRootWindow.argtypes=[D]; X.XDefaultRootWindow.restype=W
X.XGetWindowAttributes.argtypes=[D,W,C.POINTER(Attributes)]; X.XGetWindowAttributes.restype=C.c_int
X.XQueryTree.argtypes=[D,W,C.POINTER(W),C.POINTER(W),C.POINTER(C.POINTER(W)),C.POINTER(C.c_uint)]; X.XQueryTree.restype=C.c_int
X.XFetchName.argtypes=[D,W,C.POINTER(C.c_char_p)]; X.XFetchName.restype=C.c_int
X.XTranslateCoordinates.argtypes=[D,W,W,C.c_int,C.c_int,C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(W)]; X.XTranslateCoordinates.restype=C.c_int
X.XGetImage.argtypes=[D,W,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_ulong,C.c_int]; X.XGetImage.restype=C.POINTER(Image)
X.XDestroyImage.argtypes=[C.POINTER(Image)]; X.XFree.argtypes=[D]; X.XCloseDisplay.argtypes=[D]
display=X.XOpenDisplay(None)
if not display: raise RuntimeError('Cannot connect to the private Xvfb DISPLAY')
root=X.XDefaultRootWindow(display); attrs=Attributes()
assert X.XGetWindowAttributes(display,root,C.byref(attrs))
width,height=attrs.width,attrs.height
assert 0 < width*height <= 16000000
windows=[]
def walk(parent,depth=0):
    if depth>2: return
    r,p=W(),W(); children=C.POINTER(W)(); count=C.c_uint()
    if not X.XQueryTree(display,parent,C.byref(r),C.byref(p),C.byref(children),C.byref(count)): return
    ids=[children[i] for i in range(min(count.value,200))]
    if children: X.XFree(children)
    for wid in ids:
        a=Attributes(); title=C.c_char_p()
        if X.XGetWindowAttributes(display,wid,C.byref(a)) and a.map_state==2:
            name=''
            if X.XFetchName(display,wid,C.byref(title)) and title:
                name=title.value.decode('utf8','replace'); X.XFree(title)
            xx,yy=C.c_int(),C.c_int(); child=W()
            X.XTranslateCoordinates(display,wid,root,0,0,C.byref(xx),C.byref(yy),C.byref(child))
            if name: windows.append(dict(id=wid,title=name,x=xx.value,y=yy.value,width=a.width,height=a.height))
            walk(wid,depth+1)
walk(root)
image=X.XGetImage(display,root,0,0,width,height,C.c_ulong(-1).value,2)
if not image: raise RuntimeError('XGetImage failed')
i=image.contents
assert i.bits_per_pixel in (24,32) and i.xoffset==0
raw=C.string_at(i.data,i.bytes_per_line*height); bpp=i.bits_per_pixel//8
order='little' if i.byte_order==0 else 'big'
def mask_info(mask):
    shift=0
    while mask and not mask&1: mask>>=1; shift+=1
    return shift,mask
masks=[mask_info(i.red_mask),mask_info(i.green_mask),mask_info(i.blue_mask)]
rows=bytearray()
for y in range(height):
    rows.append(0)
    for x in range(width):
        offset=y*i.bytes_per_line+x*bpp
        pixel=int.from_bytes(raw[offset:offset+bpp],order)
        rows.extend(((pixel>>shift)&mask)*255//mask for shift,mask in masks)
X.XDestroyImage(image); X.XCloseDisplay(display)
def chunk(kind,data): return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')
with open(sys.argv[1],'wb') as f: f.write(png)
print(json.dumps(dict(width=width,height=height,windows=windows)))
`;

export async function captureNativeHost(
  context: LoginProbeContext,
  name: string,
): Promise<HostCapture> {
  const capturedAt = new Date().toISOString();
  const image = path.join(context.artifacts, `${name}-host.png`);
  const output = await context.command(
    "python3",
    ["-c", X11_CAPTURE, image],
    60_000,
  );
  const capture = JSON.parse(output) as Omit<HostCapture, "image" | "window">;
  await writeFile(
    path.join(context.artifacts, `${name}-host-windows.json`),
    JSON.stringify({ ...capture, capturedAt }, null, 2),
  );
  const window = capture.windows
    .filter(
      (item) =>
        item.title.includes(context.avd) ||
        /Android Emulator/i.test(item.title),
    )
    .sort((a, b) => b.width * b.height - a.width * a.height)[0];
  assert(
    window && window.width > 100 && window.height > 100,
    "No mapped native Android Emulator Qt window was found on the host display",
  );
  return { ...capture, image, window, capturedAt };
}

async function publishHostPreview(
  context: LoginProbeContext,
  host: HostCapture,
  title: string,
  detail: Record<string, unknown>,
): Promise<void> {
  if (!process.env.GITHUB_ACTIONS) return;
  // Only a fresh, empty form is captured. Keep a bounded preview accessible via
  // check annotations when the artifact storage endpoint is unavailable.
  const code = String.raw`
import base64, io, json, sys
from PIL import Image
im=Image.open(sys.argv[1]).convert('RGB')
x,y,w,h=map(int,sys.argv[2:6]); im=im.crop((x,y,x+w,y+h))
im.thumbnail((1100,700))
quality=75
while True:
    data=io.BytesIO(); im.save(data,format='JPEG',quality=quality,optimize=True)
    raw=data.getvalue()
    if len(raw)<=38000: break
    if quality>35: quality-=10
    else: im.thumbnail((int(im.width*0.85),int(im.height*0.85))); quality=65
    if im.width<160: raise RuntimeError('Cannot create a bounded login preview')
print(json.dumps(dict(mimeType='image/jpeg',width=im.width,height=im.height,bytes=len(raw),base64=base64.b64encode(raw).decode())))
`;
  const preview = JSON.parse(
    await context.command("python3", [
      "-c",
      code,
      host.image,
      String(host.window.x),
      String(host.window.y),
      String(host.window.width),
      String(host.window.height),
    ]),
  );
  assert(preview.bytes <= 38000 && preview.base64.length <= 51000);
  const { base64: encodedImage, ...imageMetadata } = preview;
  const metadata = {
    ...imageMetadata,
    capturedAt: host.capturedAt,
    ...detail,
  };
  // Public GitHub job pages truncate individual annotation messages at about
  // 4 KB. Keep each fragment independently parseable when the API is unavailable.
  const total = Math.ceil(encodedImage.length / 2800);
  const previewId = `${path.basename(host.image)}:${host.capturedAt}`;
  for (let index = 0; index < total; index++) {
    const message = JSON.stringify({
      type: "native-image-fragment",
      previewId,
      title,
      index,
      total,
      ...(index === 0 ? { metadata } : {}),
      base64Chunk: encodedImage.slice(index * 2800, (index + 1) * 2800),
    })
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.log(`::notice title=${title} ${index + 1}/${total}::${message}`);
  }
}

function summarizeNodes(value: Record<string, string>[]): unknown[] {
  const summary: unknown[] = [];
  let bytes = 0;
  for (const node of value.slice(0, 60)) {
    const item = {
      class: node.class,
      id: node["resource-id"],
      text: node.text?.slice(0, 150),
      description: node["content-desc"]?.slice(0, 150),
      bounds: node.bounds,
      clickable: node.clickable,
    };
    bytes += JSON.stringify(item).length;
    if (bytes > 9000) break;
    summary.push(item);
  }
  return summary;
}

function decodeEntities(value: string): string {
  return value.replace(
    /&(?:quot|amp|lt|gt|apos);/g,
    (entity) =>
      ({
        "&quot;": '"',
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&apos;": "'",
      })[entity]!,
  );
}
function nodes(xml: string): Record<string, string>[] {
  return [...xml.matchAll(/<node\b([^>]+)>/g)].map((match) =>
    Object.fromEntries(
      [...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((value) => [
        value[1],
        decodeEntities(value[2]),
      ]),
    ),
  );
}
function bounds(value: string): Rectangle {
  const match = value.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  assert(match, `Invalid UI bounds: ${value}`);
  const [x, y, right, bottom] = match.slice(1).map(Number);
  assert(right > x && bottom > y, "UI element is not visible");
  return { x, y, width: right - x, height: bottom - y };
}
async function ui(
  context: LoginProbeContext,
  name: string,
): Promise<Record<string, string>[]> {
  const file = `/data/local/tmp/apk-checker-${name}.xml`;
  await context.shell("uiautomator", "dump", "--compressed", file);
  const xml = await context.shell("cat", file);
  await writeFile(path.join(context.artifacts, `${name}-ui.xml`), xml);
  return nodes(xml);
}
async function tap(
  context: LoginProbeContext,
  node: Record<string, string>,
): Promise<void> {
  const box = bounds(node.bounds);
  await context.shell(
    "input",
    "tap",
    String(Math.round(box.x + box.width / 2)),
    String(Math.round(box.y + box.height / 2)),
  );
  await new Promise((resolve) => setTimeout(resolve, 700));
}

/** Navigate only original APK controls confirmed in the 2.1.8 source. */
export async function prepareKtvHome(
  context: LoginProbeContext,
  prefix: string,
): Promise<Record<string, string>[]> {
  const started = Date.now();
  const actions: string[] = [];
  let backCount = 0;
  let updateDeferrals = 0;
  let oldTargetWarnings = 0;
  let current: Record<string, string>[] = [];
  try {
    for (let attempt = 0; ; attempt++) {
      current = await ui(context, `${prefix}-navigation-${attempt}`);
      const oldTargetTitle = current.find(
        (node) => node["resource-id"] === "android:id/alertTitle" &&
          node.text === "麦动",
      );
      const oldTargetMessage = current.find(
        (node) => node["resource-id"] === "android:id/message" &&
          node.text?.startsWith("This app was built for an older version of Android."),
      );
      if (oldTargetTitle && oldTargetMessage) {
        const okay = current.find(
          (node) => node["resource-id"] === "android:id/button1" &&
            node.text === "OK" && node.clickable === "true",
        );
        const checkUpdate = current.find(
          (node) => node["resource-id"] === "android:id/button3" &&
            node.text === "Check for update",
        );
        assert(okay && checkUpdate && oldTargetWarnings === 0,
          "Old-target Android warning did not match the observed safe OK action");
        actions.push("Acknowledged Android's informational old-target warning using OK; did not check for updates");
        oldTargetWarnings++;
        await tap(context, okay);
        continue;
      }
      const updateTitle = current.find(
        (node) => node["resource-id"] === "android:id/alertTitle" &&
          /^发现新版本 \S/.test(node.text ?? ""),
      );
      if (updateTitle) {
        const later = current.find(
          (node) => node["resource-id"] === "android:id/button2" &&
            node.text === "稍后" && node.clickable === "true",
        );
        const download = current.find(
          (node) => node["resource-id"] === "android:id/button1" &&
            node.text === "下载并安装",
        );
        assert(later && download && updateDeferrals < 2,
          "Update overlay did not match the original APK's safe Later action");
        actions.push("Deferred the original APK update using its Later button");
        updateDeferrals++;
        await tap(context, later);
        continue;
      }
      const loading = current.some((node) => [
        "正在初始化曲库...",
        "已清理旧歌曲缓存，正在初始化新曲库...",
      ].includes(node.text));
      if (loading) {
        assert(Date.now() - started < 30_000,
          "Original APK library initialization did not finish within 30 seconds");
        actions.push("Waited for original APK library initialization");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }
      assert(!current.some((node) =>
        /^(旧歌曲缓存清理失败：|曲库初始化失败：)/.test(node.text ?? "")),
      "Original APK reported a library initialization failure");
      const has = (id: string) => current.some(
        (node) => node["resource-id"] === `com.local.ktv:id/${id}`,
      );
      if (has("btn_bottom_settings") && has("btn_top_search")) return current;
      const back = current.find(
        (node) => node["resource-id"] === "com.local.ktv:id/btn_back" &&
          node.clickable === "true",
      );
      assert(back && backCount < 4,
        `Cannot safely reach Maidong home from observed UI: ${JSON.stringify(summarizeNodes(current))}`);
      actions.push("Returned using the original APK Back control");
      backCount++;
      await tap(context, back);
    }
  } finally {
    await writeFile(path.join(context.artifacts, `${prefix}-navigation.json`),
      JSON.stringify({ actions, durationMs: Date.now() - started, lastUi: summarizeNodes(current) }, null, 2));
  }
}

function secureWindows(dump: string): string[] {
  return dump
    .split(/\n(?=\s*Window #\d+\s+Window\{)/)
    .filter((block) => {
      if (!block.includes("com.local.ktv")) return false;
      if (/\bSECURE\b|\bFLAG_SECURE\b/.test(block)) return true;
      return [...block.matchAll(/\b(?:fl|flags)=0x([a-f0-9]+)/gi)].some(
        (match) => (parseInt(match[1], 16) & 0x2000) !== 0,
      );
    })
    .map((block) =>
      block
        .split(/\r?\n/)
        .filter((line) =>
          /Window #|mAttrs|\bfl=|\bflags=|SECURE|mFrame|frame=/.test(line),
        )
        .slice(0, 12)
        .join("\n"),
    );
}

type Png = {
  width: number;
  height: number;
  channels: number;
  pixels: Uint8Array;
};
async function readPng(file: string): Promise<Png> {
  const png = await readFile(file);
  assert(
    png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  );
  const width = png.readUInt32BE(16),
    height = png.readUInt32BE(20),
    type = png[25];
  assert(
    png[24] === 8 &&
      [2, 6].includes(type) &&
      png[28] === 0 &&
      width * height <= 16_000_000,
    "Unsupported diagnostic PNG format",
  );
  const channels = type === 6 ? 4 : 3,
    stride = width * channels,
    chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    assert(offset + 12 + length <= png.length);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT")
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks), {
    maxOutputLength: (stride + 1) * height,
  });
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = new Uint8Array(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0,
        b = y ? pixels[(y - 1) * stride + x] : 0,
        c = y && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? Math.floor((a + b) / 2)
                : paeth(a, b, c);
      pixels[y * stride + x] =
        (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, channels, pixels };
}
function blackFraction(image: Png, rect: Rectangle): number {
  const left = Math.max(0, Math.floor(rect.x + rect.width * 0.1)),
    top = Math.max(0, Math.floor(rect.y + rect.height * 0.1));
  const right = Math.min(image.width, Math.ceil(rect.x + rect.width * 0.9)),
    bottom = Math.min(image.height, Math.ceil(rect.y + rect.height * 0.9));
  assert(
    right > left && bottom > top,
    "Input bounds do not intersect screenshot",
  );
  let black = 0,
    total = 0;
  for (let y = top; y < bottom; y++)
    for (let x = left; x < right; x++) {
      const i = (y * image.width + x) * image.channels;
      if (
        image.pixels[i] < 12 &&
        image.pixels[i + 1] < 12 &&
        image.pixels[i + 2] < 12
      )
        black++;
      total++;
    }
  return black / total;
}

export async function probeProtectedLogin(
  context: LoginProbeContext,
): Promise<unknown> {
  const result: Record<string, unknown> = {
    credentialsEntered: false,
    accountRequestSubmitted: false,
    apkSecurityFlagsModified: false,
  };
  let dialogOpened = false;
  try {
    const before = await prepareKtvHome(context, "login-01-home");
    result.lastUi = summarizeNodes(before);
    const settings = before.find(
      (node) => node["resource-id"] === "com.local.ktv:id/btn_bottom_settings",
    );
    assert(
      settings,
      "Home settings control was not found; no blind coordinate fallback was attempted",
    );
    await tap(context, settings);
    const settingsNodes = await ui(context, "login-02-settings");
    result.lastUi = summarizeNodes(settingsNodes);
    const account = settingsNodes.find(
      (node) =>
        node.clickable === "true" &&
        node["content-desc"]?.startsWith("i歌霸账号"),
    );
    assert(account, "The i歌霸 account settings action was not found");
    await context.screenshot("login-02-settings-guest.png");
    let settingsHost = await captureNativeHost(context, "login-02-settings");
    let settingsImage = await readPng(path.join(context.artifacts, "login-02-settings-guest.png"));
    const aligned = () => Math.abs(settingsImage.width / settingsImage.height -
      settingsHost.window.width / settingsHost.window.height) /
      (settingsImage.width / settingsImage.height) < 0.1;
    if (!aligned()) {
      await publishHostPreview(context, settingsHost, "Native display before alignment preview", {
        credentialsEntered: false,
        guestWidth: settingsImage.width,
        guestHeight: settingsImage.height,
      });
      const reciprocalDifference = Math.abs(settingsImage.width / settingsImage.height -
        settingsHost.window.height / settingsHost.window.width) /
        (settingsImage.width / settingsImage.height);
      assert(reciprocalDifference < 0.1 && context.rotateNativeDisplay,
        "Native display cannot be safely aligned using the observed reciprocal aspect ratio");
      const rotations: unknown[] = [];
      result.nativeDisplayRotations = rotations;
      for (let count = 1; count <= 3 && !aligned(); count++) {
        await context.rotateNativeDisplay();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await context.screenshot("login-02-settings-guest.png");
        settingsImage = await readPng(path.join(context.artifacts, "login-02-settings-guest.png"));
        settingsHost = await captureNativeHost(context, `login-02-settings-rotation-${count}`);
        rotations.push({ operation: "Native emulator console rotate clockwise", count,
          guestWidth: settingsImage.width, guestHeight: settingsImage.height,
          hostWindow: settingsHost.window, aligned: aligned() });
      }
      assert(aligned(), "Native emulator rotation did not align host and Android aspect ratios");
    }
    // Rotation can relayout controls, so use fresh semantic bounds for the tap.
    const alignedSettings = await ui(context, "login-02-settings-aligned");
    const alignedAccount = alignedSettings.find(
      (node) => node.clickable === "true" && node["content-desc"]?.startsWith("i歌霸账号"),
    );
    assert(alignedAccount, "Account settings action disappeared after native display alignment");
    await tap(context, alignedAccount);
    dialogOpened = true;
    const form = await ui(context, "login-03-dialog");
    result.lastUi = summarizeNodes(form);
    assert(
      form.some((node) => node.text === "登录 i歌霸"),
      "Expected native login dialog is not present",
    );
    const fields = form.filter(
      (node) => node.class === "android.widget.EditText",
    );
    assert(
      fields.length >= 2,
      "Login form account/password EditText nodes are missing",
    );
    const windowDump = await context.shell("dumpsys", "window", "windows");
    await writeFile(
      path.join(context.artifacts, "login-03-windows.txt"),
      windowDump,
    );
    const secure = secureWindows(windowDump);
    assert(
      secure.length > 0,
      "Original login window FLAG_SECURE was not observed",
    );
    const host = await captureNativeHost(context, "login-03-dialog");
    result.capturedAt = host.capturedAt;
    result.hostPreviewCaptured = true;
    await publishHostPreview(context, host, "Empty native login preview", {
      emptyForm: true,
      originalFlagSecurePreserved: true,
    });
    // Preserve host visibility evidence even when Android refuses or returns no
    // pixels for its protected display. An unexplained empty capture is recorded
    // as unavailable, never relabelled as proof of secure-window redaction.
    let guestImage: Png | undefined;
    try {
      await context.screenshot("login-03-dialog-guest.png");
      guestImage = await readPng(
        path.join(context.artifacts, "login-03-dialog-guest.png"),
      );
      result.guestCapture = { status: "captured" };
    } catch (error) {
      result.guestCapture = {
        status: "unavailable",
        error: String(error).slice(0, 1500),
        redactionVerified: false,
      };
    }
    const referenceImage =
      guestImage ??
      (await readPng(
        path.join(context.artifacts, "login-02-settings-guest.png"),
      ));
    const hostImage = await readPng(host.image);
    const guestAspect = referenceImage.width / referenceImage.height,
      hostAspect = host.window.width / host.window.height;
    assert(
      Math.abs(guestAspect - hostAspect) / guestAspect < 0.1,
      "Native emulator client aspect ratio cannot be safely mapped to Android input regions",
    );
    const comparisons = fields.slice(0, 2).map((node) => {
      const guest = bounds(node.bounds);
      const mapped = {
        x: host.window.x + (guest.x * host.window.width) / referenceImage.width,
        y: host.window.y + (guest.y * host.window.height) / referenceImage.height,
        width: (guest.width * host.window.width) / referenceImage.width,
        height: (guest.height * host.window.height) / referenceImage.height,
      };
      return {
        guestBounds: guest,
        hostBounds: mapped,
        guestBlackFraction: guestImage ? blackFraction(guestImage, guest) : null,
        hostBlackFraction: blackFraction(hostImage, mapped),
      };
    });
    result.secureWindows = secure;
    result.nativeEditTextCount = fields.length;
    result.inputRegionPixels = comparisons;
    result.hostWindow = host.window;
    if (guestImage)
      result.guestCapture = {
        status: "captured",
        redactionVerified: comparisons.every(
          (entry) =>
            entry.guestBlackFraction !== null && entry.guestBlackFraction > 0.95,
        ),
      };
    assert(
      comparisons.every((entry) => entry.hostBlackFraction < 0.9),
      "Native host input regions are also black; secure-login visibility is not verified",
    );
    await context.shell("input", "keyevent", "KEYCODE_BACK");
    dialogOpened = false;
    await new Promise((resolve) => setTimeout(resolve, 700));
    const restored = await ui(context, "login-04-restored");
    assert(
      !restored.some((node) => node.text === "登录 i歌霸"),
      "Back did not close the login dialog",
    );
    await context.screenshot("login-04-restored-guest.png");
    await captureNativeHost(context, "login-04-restored");
    result.dialogDismissed = true;
    result.status = "passed";
    delete result.lastUi;
    return result;
  } catch (error) {
    result.status = "failed";
    result.error = String(error);
    if (!result.hostPreviewCaptured) {
      await captureNativeHost(context, "login-failure")
        .then(async (host) => {
          result.failureHostWindow = host.window;
          await publishHostPreview(context, host, "Native login diagnostic preview", {
            credentialsEntered: false,
            accountRequestSubmitted: false,
          });
        })
        .catch((captureError) => {
          result.failureHostCaptureError = String(captureError).slice(0, 1500);
        });
    }
    publishProbeDiagnostic("Native login probe diagnostic", result);
    throw error;
  } finally {
    if (dialogOpened)
      await context
        .shell("input", "keyevent", "KEYCODE_BACK")
        .catch(() => undefined);
    await writeFile(
      path.join(context.artifacts, "login-probe.json"),
      JSON.stringify(result, null, 2),
    );
  }
}
