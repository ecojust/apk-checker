import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createServer,
  type Http2Server,
  type ServerHttp2Session,
  type ServerHttp2Stream,
  type IncomingHttpHeaders,
} from "node:http2";
import type { AddressInfo } from "node:net";
import {
  setEmulatorClipboard,
  validateClipboardText,
} from "../electron/emulator-clipboard";

const faults = vi.hoisted(() => ({ connect: false, request: false }));
vi.mock("node:http2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http2")>();
  return {
    ...actual,
    connect: (...args: Parameters<typeof actual.connect>) => {
      if (faults.connect) throw new Error("sensitive-token sensitive-text");
      const session = actual.connect(...args);
      if (faults.request)
        Object.defineProperty(session, "request", {
          value: () => {
            throw new Error("sensitive-token sensitive-text");
          },
        });
      return session;
    },
  };
});

const TOKEN = "test-token-not-a-secret";
const PREFIX = "/android.emulation.control.EmulatorController/";
const encode = (text: string) => {
  const body = Buffer.from(text, "utf8");
  const size: number[] = [];
  let value = body.length;
  do {
    size.push((value & 127) | (value > 127 ? 128 : 0));
    value >>>= 7;
  } while (value);
  return Buffer.concat([Buffer.from([0x0a, ...size]), body]);
};
const frame = (payload: Buffer) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
function respond(
  stream: ServerHttp2Stream,
  payload = Buffer.alloc(0),
  status = "0",
  message?: string,
) {
  stream.respond(
    { ":status": 200, "content-type": "application/grpc" },
    { waitForTrailers: true },
  );
  stream.on("wantTrailers", () =>
    stream.sendTrailers({
      "grpc-status": status,
      ...(message ? { "grpc-message": message } : {}),
    }),
  );
  stream.end(frame(payload));
}

describe("clipboard text validation", () => {
  it("preserves Unicode, spaces and line breaks while rejecting malformed surrogate pairs", () => {
    expect(() => validateClipboardText(" 中文🙂\né\t ")).not.toThrow();
    for (const input of ["\ud800", "\udc00", "x\ud800y", "\ud800\ud800"]) {
      expect(() => validateClipboardText(input)).toThrow("Unicode");
    }
  });
  it("enforces UTF-8 byte size, not JavaScript character count", () => {
    expect(() => validateClipboardText("中".repeat(5461))).not.toThrow();
    expect(() => validateClipboardText("中".repeat(5462))).toThrow("16 KiB");
    expect(() => validateClipboardText("a".repeat(16384))).not.toThrow();
    expect(() => validateClipboardText("a".repeat(16385))).toThrow("16 KiB");
    expect(() => validateClipboardText("prefix\0suffix")).toThrow("空字符");
    for (const input of ["", null, 1, {}, undefined])
      expect(() => validateClipboardText(input)).toThrow("请输入");
  });
});

describe("authenticated emulator clipboard gRPC", () => {
  let server: Http2Server;
  let port: number;
  let sessions: Set<ServerHttp2Session>;
  let requests: { path: string; headers: IncomingHttpHeaders; bytes: Buffer }[];
  let handler: (
    stream: ServerHttp2Stream,
    headers: IncomingHttpHeaders,
    bytes: Buffer,
  ) => void;
  let received: Promise<void>;
  let markReceived: () => void;
  let clipboard: Buffer;

  beforeEach(async () => {
    faults.connect = false;
    faults.request = false;
    sessions = new Set();
    requests = [];
    clipboard = Buffer.alloc(0);
    received = new Promise((resolve) => {
      markReceived = resolve;
    });
    handler = (stream, headers, bytes) => {
      if (headers[":path"] === `${PREFIX}setClipboard`) {
        clipboard = bytes.subarray(5);
        respond(stream);
      } else respond(stream, clipboard);
    };
    server = createServer();
    server.on("session", (session) => {
      sessions.add(session);
      session.on("error", () => {});
      session.once("close", () => sessions.delete(session));
    });
    server.on("stream", (stream, headers) => {
      stream.on("error", () => {});
      const data: Buffer[] = [];
      stream.on("data", (chunk) =>
        data.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
      );
      stream.on("end", () => {
        const bytes = Buffer.concat(data);
        requests.push({ path: String(headers[":path"]), headers, bytes });
        markReceived();
        handler(stream, headers, bytes);
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const session of sessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends exact UTF-8 protobuf text with authentication, then reads host cache once and closes its connection", async () => {
    const text = "  中文🙂 café\n第二行\t ";
    await setEmulatorClipboard(port, TOKEN, text);
    expect(requests.map((request) => request.path)).toEqual([
      `${PREFIX}setClipboard`,
      `${PREFIX}getClipboard`,
    ]);
    expect(requests[0].bytes).toEqual(frame(encode(text)));
    expect(requests[1].bytes).toEqual(frame(Buffer.alloc(0)));
    for (const request of requests) {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(request.headers["content-type"]).toBe("application/grpc");
      expect(request.headers["grpc-timeout"]).toMatch(/^\d+m$/);
      expect(
        Number(String(request.headers["grpc-timeout"]).slice(0, -1)),
      ).toBeGreaterThan(0);
      expect(
        Number(String(request.headers["grpc-timeout"]).slice(0, -1)),
      ).toBeLessThanOrEqual(5000);
      expect(request.headers[":authority"]).toBe(`127.0.0.1:${port}`);
    }
    await vi.waitFor(() => expect(sessions.size).toBe(0));
  });

  it("accepts the full allowed 16 KiB input without truncating or transforming it", async () => {
    const text = "🙂".repeat(4096);
    await setEmulatorClipboard(port, TOKEN, text);
    expect(requests[0].bytes).toEqual(frame(encode(text)));
  });

  it("handles split response frames and skips bounded unknown protobuf fields", async () => {
    const text = "分段🙂";
    handler = (stream, headers) => {
      if (headers[":path"]?.endsWith("setClipboard")) {
        respond(stream);
        return;
      }
      const payload = Buffer.concat([
        Buffer.from([0x10, 0x07]),
        encode(text),
        Buffer.from([0x1d, 0, 0, 0, 0]),
      ]);
      const response = frame(payload);
      stream.respond(
        { ":status": 200, "content-type": "application/grpc+proto" },
        { waitForTrailers: true },
      );
      stream.on("wantTrailers", () =>
        stream.sendTrailers({ "grpc-status": "0" }),
      );
      stream.write(response.subarray(0, 2));
      setImmediate(() => {
        stream.write(response.subarray(2, 6));
        stream.end(response.subarray(6));
      });
    };
    await setEmulatorClipboard(port, TOKEN, text);
  });

  it("rejects authentication failures supplied as trailers-only responses without reflecting server details", async () => {
    const text = "private account text";
    handler = (stream) => {
      stream.respond(
        {
          ":status": 200,
          "content-type": "application/grpc",
          "grpc-status": "16",
          "grpc-message": `${TOKEN} ${text}`,
        },
        { endStream: true },
      );
    };
    const error = await setEmulatorClipboard(port, TOKEN, text).catch(
      (error: Error) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("状态 16");
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain(text);
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => expect(sessions.size).toBe(0));
  });

  it("checks error trailers after a response body and never retries setClipboard", async () => {
    handler = (stream) =>
      respond(stream, Buffer.alloc(0), "13", "server-internal-secret");
    await expect(setEmulatorClipboard(port, TOKEN, "测试")).rejects.toThrow(
      "状态 13",
    );
    expect(requests).toHaveLength(1);
  });

  it.each([
    { ":status": 503, "content-type": "application/grpc" },
    { ":status": 200, "content-type": "application/json" },
  ])("rejects invalid HTTP response headers %j", async (headers) => {
    handler = (stream) => {
      stream.respond(headers);
      stream.end();
    };
    await expect(setEmulatorClipboard(port, TOKEN, "测试")).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });

  it("rejects responses without grpc-status instead of treating HTTP 200 as success", async () => {
    handler = (stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      stream.end(frame(Buffer.alloc(0)));
    };
    await expect(setEmulatorClipboard(port, TOKEN, "测试")).rejects.toThrow(
      "响应无效",
    );
    expect(requests).toHaveLength(1);
  });

  it.each(["x", "17", "0, 0", "-1"])(
    "rejects malformed gRPC status %s",
    async (status) => {
      handler = (stream) => respond(stream, Buffer.alloc(0), status);
      await expect(setEmulatorClipboard(port, TOKEN, "测试")).rejects.toThrow(
        "响应无效",
      );
    },
  );

  it.each([
    Buffer.from([1, 0, 0, 0, 0]),
    Buffer.from([0, 0, 0, 0, 8, 1]),
    Buffer.alloc(0),
    Buffer.concat([frame(Buffer.alloc(0)), frame(Buffer.alloc(0))]),
  ])(
    "rejects compressed, truncated, absent or multiple unary frames",
    async (payload) => {
      handler = (stream) => {
        stream.respond(
          { ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true },
        );
        stream.on("wantTrailers", () =>
          stream.sendTrailers({ "grpc-status": "0" }),
        );
        stream.end(payload);
      };
      await expect(setEmulatorClipboard(port, TOKEN, "测试")).rejects.toThrow(
        "响应无效",
      );
      expect(requests).toHaveLength(1);
    },
  );

  it("bounds response allocation and closes an oversized response", async () => {
    handler = (stream) => respond(stream, Buffer.alloc(64 * 1024));
    await expect(setEmulatorClipboard(port, TOKEN, "测试")).rejects.toThrow(
      "大小限制",
    );
    await vi.waitFor(() => expect(sessions.size).toBe(0));
  });

  it("bounds permanently stale readback by one deadline without resending the clipboard", async () => {
    vi.useFakeTimers();
    handler = (stream, headers) =>
      respond(
        stream,
        headers[":path"]?.endsWith("getClipboard")
          ? encode("different secret text")
          : Buffer.alloc(0),
      );
    const operation = setEmulatorClipboard(
      port,
      TOKEN,
      "expected private text",
    );
    const rejected = expect(operation).rejects.toThrow("文字传输超时");
    await received;
    await vi.waitFor(() =>
      expect(
        requests.filter((request) => request.path.endsWith("getClipboard"))
          .length,
      ).toBeGreaterThanOrEqual(2),
    );
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(
      requests.filter((request) => request.path.endsWith("setClipboard")),
    ).toHaveLength(1);
  });

  it.each([
    Buffer.from([0x0a, 4, 0x61]),
    Buffer.from([0x0a, 2, 0xc0, 0xaf]),
    Buffer.from([0x08, 1]),
    Buffer.from([
      0x0a, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]),
    Buffer.from([0x00]),
  ])(
    "rejects malformed protobuf and invalid UTF-8 readback without exposing it",
    async (payload) => {
      handler = (stream, headers) =>
        respond(
          stream,
          headers[":path"]?.endsWith("getClipboard")
            ? payload
            : Buffer.alloc(0),
        );
      await expect(setEmulatorClipboard(port, TOKEN, "测试")).rejects.toThrow(
        "响应无效",
      );
    },
  );

  it("cancels an in-flight request and does not request readback", async () => {
    handler = () => {};
    const controller = new AbortController();
    const operation = setEmulatorClipboard(
      port,
      TOKEN,
      "测试",
      controller.signal,
    );
    const rejected = expect(operation).rejects.toThrow("取消");
    await received;
    controller.abort("do not reflect this reason");
    await rejected;
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => expect(sessions.size).toBe(0));
  });

  it("times out a silent emulator and closes the connection without retrying", async () => {
    vi.useFakeTimers();
    handler = () => {};
    const operation = setEmulatorClipboard(port, TOKEN, "测试");
    const rejected = expect(operation).rejects.toThrow("超时");
    await received;
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    vi.useRealTimers();
    expect(requests).toHaveLength(1);
    await vi.waitFor(() => expect(sessions.size).toBe(0));
  });

  it("rejects invalid credentials, ports and a pre-aborted signal before connecting", async () => {
    for (const value of [0, 80, 65536, 1.5, NaN])
      await expect(setEmulatorClipboard(value, TOKEN, "测试")).rejects.toThrow(
        "凭据无效",
      );
    for (const value of [
      "",
      "a\r\nInjected: yes",
      "Bearer token",
      "a".repeat(513),
    ])
      await expect(setEmulatorClipboard(port, value, "测试")).rejects.toThrow(
        "凭据无效",
      );
    const controller = new AbortController();
    controller.abort();
    await expect(
      setEmulatorClipboard(port, TOKEN, "测试", controller.signal),
    ).rejects.toThrow("取消");
    expect(requests).toHaveLength(0);
    expect(sessions.size).toBe(0);
  });
  it("polls only GET when the asynchronous host cache is briefly stale", async () => {
    let gets = 0;
    const text = "异步🙂";
    handler = (stream, headers) => {
      if (headers[":path"]?.endsWith("setClipboard")) respond(stream);
      else respond(stream, encode(++gets === 1 ? "previous" : text));
    };
    await setEmulatorClipboard(port, TOKEN, text);
    expect(requests.map((request) => request.path)).toEqual([
      `${PREFIX}setClipboard`,
      `${PREFIX}getClipboard`,
      `${PREFIX}getClipboard`,
    ]);
  });

  it("shares one total deadline across slow SET and an unanswered GET", async () => {
    vi.useFakeTimers();
    let getReceived!: () => void;
    const getSeen = new Promise<void>((resolve) => {
      getReceived = resolve;
    });
    handler = (stream, headers) => {
      if (headers[":path"]?.endsWith("setClipboard"))
        setTimeout(() => respond(stream), 4000);
      else getReceived();
    };
    let finished = false;
    const operation = setEmulatorClipboard(port, TOKEN, "测试").finally(() => {
      finished = true;
    });
    const rejected = expect(operation).rejects.toThrow("文字传输超时");
    await received;
    await vi.advanceTimersByTimeAsync(4000);
    await getSeen;
    expect(requests[1].headers["grpc-timeout"]).toBe("1000m");
    await vi.advanceTimersByTimeAsync(999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(requests).toHaveLength(2);
  });

  it.each(["connect", "request"] as const)(
    "sanitizes synchronous %s exceptions",
    async (failure) => {
      faults[failure] = true;
      const error = await setEmulatorClipboard(
        port,
        "sensitive-token",
        "sensitive-text",
      ).catch((error: Error) => error);
      expect((error as Error).message).toBe("模拟器文字传输连接失败，请重试。");
      expect((error as Error).message).not.toContain("sensitive-token");
      expect((error as Error).message).not.toContain("sensitive-text");
      await vi.waitFor(() => expect(sessions.size).toBe(0));
    },
  );
});
