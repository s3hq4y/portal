/**
 * CdpController — drives an EXTERNAL browser (Chrome / Edge, etc.) that was
 * docked into the app via Win32 SetParent. A docked window is just a reparented
 * HWND; Electron has no handle to its page, so to control the page we talk to
 * the browser's Chrome DevTools Protocol (CDP) over its remote-debugging port.
 *
 * Requirements on the browser:
 *   - It must have been started with `--remote-debugging-port=<port>` (e.g.
 *     `--remote-debugging-port=9222`). Common defaults: 9222 (Chrome/Edge).
 *   - CDP is served as JSON over HTTP + WebSocket.
 *
 * This module is deliberately self-contained (no `ws` dependency): it ships a
 * tiny RFC6455 client over `node:net` so the bundled app needs no extra deps.
 * Connection failures are swallowed and reported via the `status` callback so
 * the UI can tell the user to launch the browser with the flag.
 */
import * as net from "node:net";
import * as http from "node:http";
import * as crypto from "node:crypto";

export type CdpAction = "back" | "forward" | "reload" | "stop";

export interface CdpStatus {
  connected: boolean;
  port: number;
  error?: string;
  url?: string;
  title?: string;
}

type Listener = (status: CdpStatus) => void;

// ---------------------------------------------------------------------------
// Minimal RFC6455 WebSocket client (text frames, client-masked).
// ---------------------------------------------------------------------------
class WsClient {
  private socket: net.Socket | null = null;
  private buffer = Buffer.alloc(0);
  private connected = false;
  private sendQueue: Buffer[] = [];
  private onText: (text: string) => void = () => {};
  private onClose: () => void = () => {};

  connect(url: URL, protocols: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const host = url.hostname;
      const port = Number(url.port) || 80;
      const path = url.pathname + url.search;
      const key = crypto.randomBytes(16).toString("base64");
      const req =
        `GET ${path} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        `Upgrade: websocket\r\n` +
        `Connection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\n` +
        (protocols.length ? `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n` : "") +
        `\r\n`;
      const sock = net.createConnection({ host, port });
      this.socket = sock;
      let handshakeBuf = "";
      let done = false;
      sock.on("connect", () => sock.write(req));
      sock.on("data", (chunk) => {
        if (!this.connected) {
          handshakeBuf += chunk.toString("binary");
          const idx = handshakeBuf.indexOf("\r\n\r\n");
          if (idx === -1) return;
          const head = handshakeBuf.slice(0, idx);
          if (!/101/.test(head.split("\r\n")[0])) {
            socketCleanup(this);
            reject(new Error(`WebSocket handshake failed: ${head.split("\r\n")[0]}`));
            return;
          }
          const accept = /sec-websocket-accept: *([^\r\n]+)/i.exec(head)?.[1]?.trim();
          const expect = crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
          if (accept && accept !== expect) {
            socketCleanup(this);
            reject(new Error("WebSocket handshake: bad Sec-WebSocket-Accept"));
            return;
          }
          this.connected = true;
          done = true;
          const remainder = Buffer.from(handshakeBuf.slice(idx + 4), "binary");
          this.buffer = Buffer.concat([this.buffer, remainder]);
          this.flush();
          resolve();
          return;
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        this.flush();
      });
      sock.on("error", (err) => { if (!done) reject(err); });
      sock.on("close", () => { this.onClose(); });
      const timer = setTimeout(() => { if (!this.connected) { socketCleanup(this); reject(new Error("WebSocket connect timeout")); } }, 8000);
      sock.on("close", () => clearTimeout(timer));
      sock.on("error", () => clearTimeout(timer));
    });

    function socketCleanup(c: WsClient) {
      try { c.close(); } catch { /* ignore */ }
    }
  }

  private flush(): void {
    while (this.connected) {
      const frame = this.parseFrame();
      if (!frame) break;
      if (frame.opcode === 0x8) { this.onClose(); break; }
      if (frame.opcode === 0x1) { this.onText(frame.payload.toString("utf8")); }
      if (frame.opcode === 0x9) { this.sendFrame(0xA, frame.payload); }
      if (frame.opcode === 0xA) { /* pong: ignore */ }
    }
  }

  private parseFrame(): { opcode: number; payload: Buffer } | null {
    if (this.buffer.length < 2) return null;
    const b0 = this.buffer[0];
    const b1 = this.buffer[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (this.buffer.length < 4) return null;
      len = this.buffer.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (this.buffer.length < 10) return null;
      len = Number(this.buffer.readBigUInt64BE(2));
      offset = 10;
    }
    let maskKey: Buffer | null = null;
    if (masked) {
      if (this.buffer.length < offset + 4) return null;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }
    if (this.buffer.length < offset + len) return null;
    let payload = this.buffer.subarray(offset, offset + len);
    if (maskKey) {
      const out = Buffer.alloc(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
      payload = out;
    }
    this.buffer = this.buffer.subarray(offset + len);
    return { opcode, payload };
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (!this.socket) return;
    const masked = true;
    let header: Buffer;
    const len = payload.length;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = (masked ? 0x80 : 0) | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = (masked ? 0x80 : 0) | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = (masked ? 0x80 : 0) | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    const mask = crypto.randomBytes(4);
    if (masked) {
      header[0] = (opcode & 0x0f) | 0x80;
      const maskedPayload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) maskedPayload[i] = payload[i] ^ mask[i % 4];
      this.socket.write(Buffer.concat([header, mask, maskedPayload]));
    } else {
      header[0] = opcode & 0x0f;
      this.socket.write(Buffer.concat([header, payload]));
    }
  }

  send(text: string): void {
    if (!this.connected) { this.sendQueue.push(Buffer.from(text, "utf8")); return; }
    this.sendFrame(0x1, Buffer.from(text, "utf8"));
  }

  onMessage(fn: (text: string) => void): void { this.onText = fn; }
  onDisconnect(fn: () => void): void { this.onClose = fn; }

  close(): void {
    try { this.sendFrame(0x8, Buffer.alloc(0)); } catch { /* ignore */ }
    try { this.socket?.end(); } catch { /* ignore */ }
    this.socket = null;
    this.connected = false;
  }
}

// ---------------------------------------------------------------------------
// CDP controller
// ---------------------------------------------------------------------------
export class CdpController {
  private ws: WsClient | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private defaultPort: number;
  private listeners = new Set<Listener>();

  constructor(defaultPort = 9222) {
    this.defaultPort = defaultPort;
  }

  onStatus(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(status: CdpStatus): void {
    for (const fn of this.listeners) { try { fn(status); } catch { /* ignore */ } }
  }

  getStatus(): CdpStatus {
    return { connected: !!this.ws, port: this.defaultPort };
  }

  /** Discover CDP targets on a port; return the first page target (or matching title). */
  discover(port = this.defaultPort, title?: string): Promise<{ id: string; url: string; title: string; wsUrl: string } | null> {
    return new Promise((resolve) => {
      const req = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 2500 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const list = JSON.parse(data) as Array<{ id: string; url: string; title: string; webSocketDebuggerUrl: string; type: string }>;
            const pages = list.filter((t) => t.type === "page" || !t.type);
            const exact = title ? pages.find((t) => t.title && t.title.includes(title)) : undefined;
            const target = exact ?? pages[0];
            if (target) resolve({ id: target.id, url: target.url, title: target.title, wsUrl: target.webSocketDebuggerUrl });
            else resolve(null);
          } catch {
            resolve(null);
          }
        });
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
    });
  }

  private sendPromise(method: string, params?: Record<string, unknown>): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws?.send(JSON.stringify({ id, method, params: params ?? {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }
      }, 8000);
    });
  }

  /** Connect to a CDP page target by port (optionally matching title). */
  async connect(port = this.defaultPort, title?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const target = await this.discover(port, title);
      if (!target) return { ok: false, error: `No debuggable page found on port ${port}. Launch the browser with --remote-debugging-port=${port}.` };
      await this.close();
      const ws = new WsClient();
      this.ws = ws;
      ws.onMessage((text) => {
        try {
          const msg = JSON.parse(text);
          if (msg.id && this.pending.has(msg.id)) {
            const p = this.pending.get(msg.id)!;
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? String(msg.error)));
            else p.resolve(msg.result);
          }
        } catch { /* ignore */ }
      });
      ws.onDisconnect(() => { this.ws = null; this.emit({ connected: false, port }); });
      await ws.connect(new URL(target.wsUrl), []);
      this.emit({ connected: true, port, url: target.url, title: target.title });
      return { ok: true };
    } catch (e: any) {
      this.emit({ connected: false, port, error: e?.message ?? String(e) });
      return { ok: false, error: e?.message ?? String(e) };
    }
  }

  async navigate(url: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.ws) return { ok: false, error: "Not connected to a browser." };
    try {
      await this.sendPromise("Page.navigate", { url });
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  }

  async control(action: CdpAction): Promise<{ ok: boolean; error?: string }> {
    if (!this.ws) return { ok: false, error: "Not connected to a browser." };
    try {
      switch (action) {
        case "reload":
          await this.sendPromise("Page.reload", { ignoreCache: false });
          break;
        case "stop":
          await this.sendPromise("Page.stopLoading");
          break;
        case "back":
          await this.sendPromise("Runtime.evaluate", { expression: "location.reload ? history.back() : void 0" });
          break;
        case "forward":
          await this.sendPromise("Runtime.evaluate", { expression: "history.forward()" });
          break;
      }
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  }

  async close(): Promise<void> {
    if (this.ws) { const w = this.ws; this.ws = null; w.close(); }
    this.pending.clear();
    this.emit({ connected: false, port: this.defaultPort });
  }
}
