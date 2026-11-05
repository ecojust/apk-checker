import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  captureNativeHost,
  prepareKtvHome,
  publishProbeDiagnostic,
  type LoginProbeContext,
} from "./login-smoke";

export interface KeyboardProbeContext extends LoginProbeContext {
  sendText?(text: string): Promise<void>;
}

type Node = Record<string, string>;

// This runs only on a private CI Xvfb display. Text enters through XTest host
// keyboard events, never adb input text or an injected Android input method.
// The clipboard owner serves real X11 selection requests while Ctrl+V is sent.
const X11_KEYBOARD = String.raw`
import ctypes as C, ctypes.util, json, select, sys, time
D=C.c_void_p; W=C.c_ulong; A=C.c_ulong; T=C.c_ulong
X=C.CDLL(ctypes.util.find_library('X11'))
xtst=ctypes.util.find_library('Xtst')
if not xtst: raise RuntimeError('XTest library is required for the host keyboard probe')
XT=C.CDLL(xtst)
class SelectionRequest(C.Structure):
    _fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',D),('owner',W),('requestor',W),('selection',A),('target',A),('property',A),('time',T)]
class SelectionNotify(C.Structure):
    _fields_=[('type',C.c_int),('serial',C.c_ulong),('send_event',C.c_int),('display',D),('requestor',W),('selection',A),('target',A),('property',A),('time',T)]
class Event(C.Union):
    _fields_=[('type',C.c_int),('request',SelectionRequest),('notify',SelectionNotify),('padding',C.c_long*24)]
X.XOpenDisplay.argtypes=[C.c_char_p]; X.XOpenDisplay.restype=D
X.XCloseDisplay.argtypes=[D]
X.XDefaultRootWindow.argtypes=[D]; X.XDefaultRootWindow.restype=W
X.XRaiseWindow.argtypes=[D,W]; X.XSetInputFocus.argtypes=[D,W,C.c_int,T]
X.XGetInputFocus.argtypes=[D,C.POINTER(W),C.POINTER(C.c_int)]
X.XSync.argtypes=[D,C.c_int]; X.XFlush.argtypes=[D]
X.XStringToKeysym.argtypes=[C.c_char_p]; X.XStringToKeysym.restype=C.c_ulong
X.XKeysymToKeycode.argtypes=[D,C.c_ulong]; X.XKeysymToKeycode.restype=C.c_ubyte
XT.XTestQueryExtension.argtypes=[D,C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int),C.POINTER(C.c_int)]
XT.XTestFakeKeyEvent.argtypes=[D,C.c_uint,C.c_int,C.c_ulong]; XT.XTestFakeKeyEvent.restype=C.c_int
X.XInternAtom.argtypes=[D,C.c_char_p,C.c_int]; X.XInternAtom.restype=A
X.XCreateSimpleWindow.argtypes=[D,W,C.c_int,C.c_int,C.c_uint,C.c_uint,C.c_uint,C.c_ulong,C.c_ulong]; X.XCreateSimpleWindow.restype=W
X.XDestroyWindow.argtypes=[D,W]
X.XSetSelectionOwner.argtypes=[D,A,W,T]; X.XGetSelectionOwner.argtypes=[D,A]; X.XGetSelectionOwner.restype=W
X.XChangeProperty.argtypes=[D,W,A,A,C.c_int,C.c_int,C.POINTER(C.c_ubyte),C.c_int]
X.XSendEvent.argtypes=[D,W,C.c_int,C.c_long,C.POINTER(Event)]
X.XPending.argtypes=[D]; X.XNextEvent.argtypes=[D,C.POINTER(Event)]
X.XConnectionNumber.argtypes=[D]; X.XConnectionNumber.restype=C.c_int
mode=sys.argv[1]; window=int(sys.argv[2]); text=sys.argv[3]
assert mode in ('ascii','clipboard')
assert text == ('abc123' if mode=='ascii' else '\u6d4b\u8bd5123'), 'Only public probe text is permitted'
display=X.XOpenDisplay(None)
if not display: raise RuntimeError('Cannot connect to the private Xvfb DISPLAY')
owner=0; held=set(); served=[]; sent=[]
def key(name,down):
    code=int(X.XKeysymToKeycode(display,X.XStringToKeysym(name.encode('ascii'))))
    if not code: raise RuntimeError('X11 key is unmapped: '+name)
    if not XT.XTestFakeKeyEvent(display,code,int(down),0): raise RuntimeError('XTest key injection failed')
    if down: held.add(code)
    else: held.discard(code)
    X.XFlush(display); sent.append(dict(key=name,down=bool(down),code=code))
try:
    values=[C.c_int() for _ in range(4)]
    if not XT.XTestQueryExtension(display,*[C.byref(v) for v in values]): raise RuntimeError('XTest extension is unavailable')
    X.XRaiseWindow(display,window); X.XSetInputFocus(display,window,2,0); X.XSync(display,0)
    focused=W(); revert=C.c_int(); X.XGetInputFocus(display,C.byref(focused),C.byref(revert))
    if focused.value!=window: raise RuntimeError('Native emulator window did not gain X11 keyboard focus')
    time.sleep(0.15)
    if mode=='ascii':
        for character in text:
            key(character,True); time.sleep(0.03); key(character,False); time.sleep(0.05)
    else:
        atom=lambda name: X.XInternAtom(display,name.encode('ascii'),False)
        clipboard=atom('CLIPBOARD'); utf8=atom('UTF8_STRING'); targets=atom('TARGETS'); atom_type=atom('ATOM')
        formats=[utf8,atom('text/plain;charset=utf-8'),atom('text/plain'),atom('TEXT')]
        data=text.encode('utf8')
        owner=X.XCreateSimpleWindow(display,X.XDefaultRootWindow(display),0,0,1,1,0,0,0)
        X.XSetSelectionOwner(display,clipboard,owner,0); X.XSync(display,0)
        if X.XGetSelectionOwner(display,clipboard)!=owner: raise RuntimeError('Cannot own the X11 CLIPBOARD selection')
        def serve(duration):
            deadline=time.monotonic()+duration
            while time.monotonic()<deadline:
                if not X.XPending(display):
                    select.select([X.XConnectionNumber(display)],[],[],min(0.05,max(0,deadline-time.monotonic())))
                    continue
                event=Event(); X.XNextEvent(display,C.byref(event))
                if event.type!=30: continue
                request=event.request
                response=Event(); notice=response.notify
                notice.type=31; notice.display=display; notice.requestor=request.requestor
                notice.selection=request.selection; notice.target=request.target; notice.time=request.time
                prop=request.property or request.target
                notice.property=0
                if request.selection==clipboard and request.target==targets:
                    available=(A*(len(formats)+1))(targets,*formats)
                    X.XChangeProperty(display,request.requestor,prop,atom_type,32,0,C.cast(available,C.POINTER(C.c_ubyte)),len(available))
                    notice.property=prop; served.append('TARGETS')
                elif request.selection==clipboard and request.target in formats:
                    buffer=(C.c_ubyte*len(data)).from_buffer_copy(data)
                    X.XChangeProperty(display,request.requestor,prop,utf8,8,0,buffer,len(data))
                    notice.property=prop; served.append('UTF8_STRING')
                X.XSendEvent(display,request.requestor,False,0,C.byref(response)); X.XFlush(display)
        # Qt may synchronize the host selection to Android before the paste key.
        serve(0.6)
        key('Control_L',True); key('v',True); key('v',False); key('Control_L',False)
        serve(2.0)
        if 'UTF8_STRING' not in served: raise RuntimeError('Native window did not request the UTF-8 host clipboard payload')
    X.XSync(display,0)
    print(json.dumps(dict(mode=mode,text=text,window=window,keyEvents=sent,clipboardRequests=served)))
finally:
    for code in held: XT.XTestFakeKeyEvent(display,code,False,0)
    if owner: X.XDestroyWindow(display,owner)
    X.XSync(display,0); X.XCloseDisplay(display)
`;

function attributes(xml: string): Node[] {
  const entities: Record<string, string> = {
    "&quot;": '"',
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&apos;": "'",
  };
  return [...xml.matchAll(/<node\b([^>]+)>/g)].map((node) =>
    Object.fromEntries(
      [...node[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((attr) => [
        attr[1],
        attr[2].replace(
          /&(?:quot|amp|lt|gt|apos|#\d+|#x[\da-fA-F]+);/g,
          (entity) => {
            if (entities[entity] !== undefined) return entities[entity];
            const point = entity.startsWith("&#x")
              ? Number.parseInt(entity.slice(3, -1), 16)
              : Number.parseInt(entity.slice(2, -1), 10);
            return point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
              ? String.fromCodePoint(point)
              : entity;
          },
        ),
      ]),
    ),
  );
}
async function ui(context: LoginProbeContext, name: string): Promise<Node[]> {
  const file = `/data/local/tmp/apk-checker-${name}.xml`;
  await context.shell("uiautomator", "dump", "--compressed", file);
  const xml = await context.shell("cat", file);
  await writeFile(path.join(context.artifacts, `${name}-ui.xml`), xml);
  const nodes = attributes(xml);
  assert(
    !nodes.some(
      (node) =>
        node.password === "true" ||
        /^(?:登录 i歌霸|注册 i歌霸账号)$/.test(node.text),
    ),
    "Host keyboard probe refuses to interact with account or password fields",
  );
  return nodes;
}
function find(nodes: Node[], id: string): Node | undefined {
  return nodes.find((node) => node["resource-id"] === `com.local.ktv:id/${id}`);
}
async function tap(context: LoginProbeContext, node: Node): Promise<void> {
  const match = node.bounds?.match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
  assert(match, "Expected a visible Android control with bounds");
  const [left, top, right, bottom] = match.slice(1).map(Number);
  assert(right > left && bottom > top, "Android control has empty bounds");
  await context.shell(
    "input",
    "tap",
    String(Math.round((left + right) / 2)),
    String(Math.round((top + bottom) / 2)),
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
}
async function focusEmptySearch(
  context: LoginProbeContext,
  name: string,
): Promise<void> {
  let nodes = await ui(context, `${name}-before-clear`);
  const clear = find(nodes, "key_clear");
  assert(clear, "Maidong search clear action was not found");
  await tap(context, clear);
  nodes = await ui(context, `${name}-cleared`);
  const input = find(nodes, "search_input");
  assert(
    input?.class === "android.widget.EditText" && input.password !== "true",
    "Only the public Maidong search EditText may receive probe text",
  );
  // UIAutomator may report the hint as text when the input is empty.
  assert(
    !input.text ||
      input.text === input.hint ||
      input.text === "搜索  输入首字母搜索",
    "Search was not cleared before host keyboard input",
  );
  await tap(context, input);
}

async function focusSearchWithNavigation(
  context: LoginProbeContext,
  name: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const trace: Record<string, unknown>[] = [];
  detail.focusNavigation = trace;
  let keySent: string | null = null;
  for (let step = 0; step <= 12; step++) {
    const nodes = await ui(context, `${name}-focus-${step}`);
    const input = find(nodes, "search_input");
    const focused = nodes.filter((node) => node.focused === "true");
    trace.push({
      step,
      keySent,
      focused: focused.slice(0, 8).map((node) => ({
        resourceId: node["resource-id"],
        class: node.class,
        bounds: node.bounds,
      })),
      search: input && {
        focused: input.focused,
        focusable: input.focusable,
        bounds: input.bounds,
      },
    });
    assert(
      input?.class === "android.widget.EditText" && input.password !== "true",
      "Focus navigation requires the public Maidong search EditText",
    );
    if (input.focused === "true") return;
    if (step === 12) break;
    // Maidong disables focus in touch mode on this EditText. Tab enters
    // keyboard navigation without activating controls. In the original layout,
    // backspace and clear are immediately to the right of the search input.
    const onSearchAction = focused.some((node) =>
      /:id\/key_(?:clear|backspace)$/.test(node["resource-id"]),
    );
    keySent = onSearchAction ? "KEYCODE_DPAD_LEFT" : "KEYCODE_TAB";
    await context.shell("input", "keyevent", keySent);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(
    "The public search EditText did not gain focus after 12 navigation keys; no text was sent (see focusNavigation and saved UI dumps)",
  );
}

async function verifySearchText(
  context: LoginProbeContext,
  name: string,
  expected: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
  const after = await ui(context, `${name}-after`);
  const actual = find(after, "search_input")?.text;
  detail.expected = expected;
  detail.actual = actual;
  await context.screenshot(`${name}-guest.png`);
  const host = await captureNativeHost(context, `${name}-after`);
  Object.assign(detail, {
    hostWindow: host.window,
    hostImage: host.image,
    capturedAt: host.capturedAt,
  });
  assert.equal(
    actual,
    expected,
    `${name} text did not reach the Android search EditText`,
  );
}
async function assertSearchFocused(
  context: LoginProbeContext,
  name: string,
): Promise<void> {
  const nodes = await ui(context, `${name}-focused`);
  const input = find(nodes, "search_input");
  assert(
    input?.class === "android.widget.EditText" &&
      input.focused === "true" &&
      input.password !== "true",
    "The public search EditText did not gain focus; no text was sent",
  );
}

/** Opt-in Linux/Xvfb integration probe. Requires a clean, running native AVD. */
export async function probeHostKeyboard(
  context: KeyboardProbeContext,
): Promise<unknown> {
  assert.equal(
    process.platform,
    "linux",
    "Host keyboard probe currently requires Linux X11/XTest",
  );
  const errors: { stage: string; error: string }[] = [];
  const result: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    scope:
      "Linux native Qt X11 key events, UTF-8 host clipboard paste and optional production sendText callback into public Maidong search; not macOS IME composition or physical hardware validation",
    credentialsEntered: false,
    accountRequestSubmitted: false,
    adbTextInjectionUsed: false,
    enterSent: false,
    errors,
  };
  let searchOpened = false;
  const run = async (
    stage: string,
    action: (detail: Record<string, unknown>) => Promise<void>,
  ) => {
    const detail: Record<string, unknown> = { status: "running" };
    result[stage] = detail;
    try {
      await action(detail);
      detail.status = "passed";
    } catch (error) {
      detail.status = "failed";
      detail.error = String(error);
      errors.push({ stage, error: String(error) });
      await context
        .screenshot(`keyboard-${stage}-failure-guest.png`)
        .catch(() => undefined);
      await captureNativeHost(context, `keyboard-${stage}-failure`).catch(
        () => undefined,
      );
    }
  };
  try {
    const nodes = await prepareKtvHome(context, "keyboard-01-home");
    const search = find(nodes, "btn_top_search");
    assert(search, "Maidong home search action was not found");
    await tap(context, search);
    searchOpened = true;
    for (const [mode, text] of [
      ["ascii", "abc123"],
      ["clipboard", "测试123"],
    ] as const) {
      await run(mode, async (detail) => {
        const name = `keyboard-${mode}`;
        await focusEmptySearch(context, name);
        await focusSearchWithNavigation(context, name, detail);
        await assertSearchFocused(context, name);
        const host = await captureNativeHost(context, `${name}-before`);
        assert(
          host.window.title.includes(context.avd),
          "Host keyboard events require a window belonging to the exact private test AVD",
        );
        detail.transport = JSON.parse(
          await context.command(
            "python3",
            ["-c", X11_KEYBOARD, mode, String(host.window.id), text],
            15_000,
          ),
        );
        await verifySearchText(context, name, text, detail);
      });
    }
    if (context.sendText) {
      await run("productionText", async (detail) => {
        await focusEmptySearch(context, "keyboard-production");
        await focusSearchWithNavigation(context, "keyboard-production", detail);
        const checks: Record<string, unknown>[] = [];
        detail.transport =
          "production sendText callback; no host keyboard event substitution";
        detail.checks = checks;
        let expected = "";
        // Known public test data only. Do not press Enter or use account fields.
        const pieces = ["中文测试", " abc123 ", " 引号'\"\\"];
        for (const [index, text] of pieces.entries()) {
          const name = `keyboard-production-${index}`;
          await assertSearchFocused(context, name);
          await context.sendText!(text);
          expected += text;
          const check: Record<string, unknown> = { sent: text };
          checks.push(check);
          await verifySearchText(context, name, expected, check);
        }
        // Distinct consecutive requests check clipboard replacement. Verify
        // focus before each send without a screenshot between the requests.
        await assertSearchFocused(context, "keyboard-production-consecutive");
        await context.sendText!("甲");
        await assertSearchFocused(context, "keyboard-production-consecutive-2");
        await context.sendText!("乙");
        expected += "甲乙";
        const consecutive: Record<string, unknown> = { sent: ["甲", "乙"] };
        checks.push(consecutive);
        await verifySearchText(
          context,
          "keyboard-production-consecutive",
          expected,
          consecutive,
        );
      });
    } else
      result.productionText = {
        status: "not-run",
        reason: "No production sendText callback was supplied",
      };
    result.productionEmoji = {
      status: "not-run",
      reason:
        "Guest supplementary Unicode remains unverified: API 30/36 UIAutomator dumpers preserve surrogate pairs, but serializer round-trip has not been independently checked. BMP Chinese, ASCII, quotes and consecutive requests retain strict guest-text assertions.",
    };
  } catch (error) {
    errors.push({ stage: "navigation", error: String(error) });
    await context
      .screenshot("keyboard-navigation-failure-guest.png")
      .catch(() => undefined);
    await captureNativeHost(context, "keyboard-navigation-failure").catch(
      () => undefined,
    );
  } finally {
    if (searchOpened) {
      try {
        await focusEmptySearch(context, "keyboard-cleanup");
        result.searchCleared = true;
        await prepareKtvHome(context, "keyboard-restored-home");
        result.homeRestored = true;
      } catch (error) {
        errors.push({ stage: "cleanup", error: String(error) });
      }
    }
    result.status = errors.length ? "failed" : "passed";
    result.finishedAt = new Date().toISOString();
    await writeFile(
      path.join(context.artifacts, "keyboard-probe.json"),
      JSON.stringify(result, null, 2),
    );
    publishProbeDiagnostic("Native keyboard probe diagnostic", result);
  }
  assert.equal(
    errors.length,
    0,
    `Host keyboard probe failed: ${errors.map((item) => `${item.stage}: ${item.error}`).join("; ")}`,
  );
  return result;
}
