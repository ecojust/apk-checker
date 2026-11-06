import {
  connect,
  constants,
  type ClientHttp2Session,
  type IncomingHttpHeaders,
} from "node:http2";

const MAX_TEXT_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = MAX_TEXT_BYTES + 1024;
const TOTAL_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 100;
const SERVICE = "/android.emulation.control.EmulatorController/";
class ClipboardTransferError extends Error {}
const protocolError = () =>
  new ClipboardTransferError("模拟器文字传输响应无效，请重试。");
const abortedError = () => new ClipboardTransferError("文字发送已取消。");

/** Keep all user text out of diagnostics, including invalid Unicode input. */
export function validateClipboardText(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ClipboardTransferError("请输入要发送的文字。");
  }
  if (Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new ClipboardTransferError("发送的文字不能超过 16 KiB。");
  }
  if (value.includes("\0")) {
    throw new ClipboardTransferError("文字不能包含空字符。");
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new ClipboardTransferError("文字包含无效的 Unicode 字符。");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new ClipboardTransferError("文字包含无效的 Unicode 字符。");
    }
  }
}

function encodeVarint(value: number): Buffer {
  const result: number[] = [];
  do {
    const part = value & 0x7f;
    value = Math.floor(value / 128);
    result.push(part | (value ? 0x80 : 0));
  } while (value);
  return Buffer.from(result);
}

function encodeText(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  return Buffer.concat([
    Buffer.from([0x0a]),
    encodeVarint(bytes.length),
    bytes,
  ]);
}

function readVarint(
  bytes: Buffer,
  offset: number,
): { value: bigint; offset: number } {
  let value = 0n;
  for (let count = 0; count < 10; count += 1) {
    if (offset >= bytes.length) throw protocolError();
    const byte = bytes[offset++];
    if (count === 9 && byte > 1) throw protocolError();
    value |= BigInt(byte & 0x7f) << BigInt(count * 7);
    if (!(byte & 0x80)) return { value, offset };
  }
  throw protocolError();
}

function decodeText(bytes: Buffer): string {
  let offset = 0;
  let text = "";
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    offset = tag.offset;
    const field = tag.value >> 3n;
    const wire = Number(tag.value & 7n);
    if (field === 0n || field > 0x1fffffffn || (field === 1n && wire !== 2)) {
      throw protocolError();
    }
    switch (wire) {
      case 0:
        offset = readVarint(bytes, offset).offset;
        break;
      case 1:
        offset += 8;
        break;
      case 2: {
        const length = readVarint(bytes, offset);
        if (length.value > BigInt(MAX_RESPONSE_BYTES)) throw protocolError();
        offset = length.offset;
        const end = offset + Number(length.value);
        if (end > bytes.length) throw protocolError();
        if (field === 1n) {
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(
              bytes.subarray(offset, end),
            );
          } catch {
            throw protocolError();
          }
        }
        offset = end;
        break;
      }
      case 5:
        offset += 4;
        break;
      default:
        throw protocolError();
    }
    if (offset > bytes.length) throw protocolError();
  }
  return text;
}

function grpcFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function unary(
  session: ClientHttp2Session,
  method: "setClipboard" | "getClipboard",
  token: string,
  payload: Buffer,
  signal: AbortSignal,
  timeout: number,
): Promise<Buffer> {
  if (signal?.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    let sawHeaders = false;
    let grpcStatus: string | undefined;
    const request = session.request({
      ":method": "POST",
      ":path": `${SERVICE}${method}`,
      "content-type": "application/grpc",
      te: "trailers",
      "grpc-timeout": `${timeout}m`,
      "grpc-accept-encoding": "identity",
      authorization: `Bearer ${token}`,
    });
    const finish = (error?: Error, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      session.removeListener("error", onSessionError);
      if (error) {
        try {
          request.close(constants.NGHTTP2_CANCEL);
        } catch {
          /* Already closed. */
        }
        request.destroy();
        reject(error);
      } else resolve(result!);
    };
    const onAbort = () => finish(abortedError());
    const onSessionError = () =>
      finish(new ClipboardTransferError("无法连接模拟器文字传输服务。"));
    const timer = setTimeout(
      () => finish(new ClipboardTransferError("模拟器文字传输超时，请重试。")),
      timeout,
    );
    const readStatus = (headers: IncomingHttpHeaders) => {
      const status = headers["grpc-status"];
      if (status === undefined) return;
      if (typeof status !== "string" || !/^(?:[0-9]|1[0-6])$/.test(status)) {
        finish(protocolError());
        return;
      }
      grpcStatus = status;
      if (status !== "0")
        finish(
          new ClipboardTransferError(
            `模拟器文字传输失败（gRPC 状态 ${status}）。`,
          ),
        );
    };
    request.on("response", (headers) => {
      sawHeaders = true;
      if (headers[":status"] !== 200) {
        finish(
          new ClipboardTransferError(
            "模拟器文字传输服务返回了无效的 HTTP 状态。",
          ),
        );
        return;
      }
      const contentType = headers["content-type"];
      if (
        typeof contentType !== "string" ||
        !/^application\/grpc(?:\+proto)?(?:\s*;.*)?$/i.test(contentType)
      ) {
        finish(protocolError());
        return;
      }
      readStatus(headers);
    });
    request.on("trailers", readStatus);
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES + 5) {
        finish(new ClipboardTransferError("模拟器文字传输响应超过大小限制。"));
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", () =>
      finish(new ClipboardTransferError("模拟器文字传输连接已中断。")),
    );
    request.once("close", () => {
      if (!settled)
        finish(new ClipboardTransferError("模拟器文字传输连接已关闭。"));
    });
    request.once("end", () => {
      if (settled) return;
      if (!sawHeaders || grpcStatus !== "0") {
        finish(protocolError());
        return;
      }
      const data = Buffer.concat(chunks, size);
      if (
        data.length < 5 ||
        data[0] !== 0 ||
        data.readUInt32BE(1) !== data.length - 5
      ) {
        finish(protocolError());
        return;
      }
      finish(undefined, data.subarray(5));
    });
    session.once("error", onSessionError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else request.end(grpcFrame(payload));
  });
}

function pollDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

/**
 * Use the authenticated official Emulator clipboard endpoint, never the host
 * clipboard. Readback confirms only the emulator's host-side cache: setClipboard
 * schedules guest delivery asynchronously and this is not a guest receipt ACK.
 * Set once, poll only getClipboard under one total deadline, and never paste or
 * retry a mutation here. The caller may issue one paste after this completes.
 */
export async function setEmulatorClipboard(
  port: number,
  token: string,
  text: string,
  signal?: AbortSignal,
): Promise<void> {
  validateClipboardText(text);
  if (
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > 512 ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)
  ) {
    throw new ClipboardTransferError(
      "模拟器文字传输凭据无效，请重新打开模拟器。",
    );
  }
  if (signal?.aborted) throw abortedError();
  const controller = new AbortController();
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TOTAL_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  let session: ClientHttp2Session | undefined;
  const remaining = () => {
    const time = deadline - Date.now();
    if (time <= 0) {
      timedOut = true;
      controller.abort();
      throw new ClipboardTransferError("模拟器文字传输超时，请重试。");
    }
    return time;
  };
  try {
    if (controller.signal.aborted) throw abortedError();
    session = connect(`http://127.0.0.1:${port}`, {
      settings: { enablePush: false, maxHeaderListSize: 8192 },
    });
    // Keep late transport errors handled during teardown without exposing details.
    session.on("error", () => {});
    session.on("stream", (stream) => stream.close(constants.NGHTTP2_CANCEL));
    const reply = await unary(
      session,
      "setClipboard",
      token,
      encodeText(text),
      controller.signal,
      remaining(),
    );
    if (reply.length !== 0) throw protocolError();
    for (;;) {
      const readback = await unary(
        session,
        "getClipboard",
        token,
        Buffer.alloc(0),
        controller.signal,
        remaining(),
      );
      if (decodeText(readback) === text) return;
      await pollDelay(
        Math.min(POLL_INTERVAL_MS, remaining()),
        controller.signal,
      );
    }
  } catch (error) {
    if (timedOut)
      throw new ClipboardTransferError("模拟器文字传输超时，请重试。");
    if (error instanceof ClipboardTransferError) throw error;
    throw new ClipboardTransferError("模拟器文字传输连接失败，请重试。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    session?.destroy();
  }
}
