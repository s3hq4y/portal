/**
 * Minimal MCP server speaking the Streamable HTTP transport (JSON-RPC 2.0),
 * hand-rolled on node:http — no SDK dependency.
 *
 * Routes served on 127.0.0.1:<port>:
 *   POST /mcp/<routeToken>   JSON-RPC requests (initialize / tools/list / tools/call ...)
 *   GET  /health             liveness probe
 *   any  /files/<token>/...  delegated to files/http.ts (the file-transfer API)
 *
 * Responses are plain JSON, or a single-event SSE stream when the client
 * sends Accept: text/event-stream.
 */
import * as http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { ToolCallResult, ToolExecutor } from "./tool-executor";
import { FileHttpOptions, handleFilesHttp, isFilesRequest } from "./files/http";

export interface ServerInfo { name: string; version: string; }

export interface McpActivityHooks {
  onSessionCreated?: () => void;
  onRequestStart?: () => void;
  onRequestEnd?: (info: { tool: string; ok: boolean; durationMs: number; args: any; resultText: string }) => void;
}

interface JsonRpcResp { jsonrpc: "2.0"; id: number | string | null; result?: unknown; error?: { code: number; message: string }; }

// 8 MiB request cap — protects the local server from runaway tool arguments.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

// Cryptographically random 32-char hex token used in the public URL path.
export function generateRouteToken(): string {
  const bytes = randomBytes(16);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const DEFAULT_SERVER_INSTRUCTIONS = `You are connected to the user's VS Code workspace via Portal, a deliberately minimal MCP server: commands and file transfer only.

Session:
- Reuse the Mcp-Session-Id returned by initialize for later requests. If it is lost or rejected, initialize again instead of guessing an ID.

Commands:
- run_command is foreground, defaults to a 120-second timeout, and returns structured execution metadata.
- For long-running work use start_command, poll read_command with next_offset values, and always call stop_command when the process is no longer needed.
- Shell mode accepts command+shell. Direct executable+args mode avoids shell quoting/injection and is preferred when shell syntax is unnecessary.
- On a local Windows folder the default is Windows PowerShell. Select pwsh for PowerShell 7, cmd for cmd.exe, or bash/sh for detected Git Bash. UTF-8 setup is applied automatically.
- If the VS Code window is a WSL folder, Portal keeps the tunnel on Windows but maps the workspace to \\\\wsl.localhost\\<distro>\\... and runs default commands with wsl.exe inside that distro. Explicit shell=powershell/cmd still runs on Windows against the UNC path.
- Use cwd rather than embedding directory changes in command strings.

File transfer:
- There are no text edit tools on this server (no read_file/write_file/edit_file/search/list tools). All file movement goes through the HTTP file API: call file_transfer_info for the tokenized endpoints (download/upload/delete/pack/unpack, GET/PUT/POST /files/<token>/...).
- Inspect results after running commands and ask before destructive or irreversible operations.`;

export class McpHttpServer {
  private sessions = new Map<string, { id: string; createdAt: number }>();
  private executor: ToolExecutor;
  private serverInfo: ServerInfo;
  private httpServer?: http.Server;
  public port: number = 0;
  private fileHttp: FileHttpOptions | undefined;

  constructor(executor: ToolExecutor, serverInfo: ServerInfo, private readonly hooks?: McpActivityHooks, private readonly routeToken = "", private readonly customInstructions = "") {
    this.executor = executor;
    this.serverInfo = serverInfo;
  }

  // Resolve the agent instructions returned on initialize: a non-empty
  // `portal.agentInstructions` setting wins, otherwise the built-in default.
  private effectiveInstructions(): string {
    const custom = this.customInstructions.trim();
    return custom ? custom : DEFAULT_SERVER_INSTRUCTIONS;
  }

  setFileHttp(opts: FileHttpOptions): void {
    this.fileHttp = opts;
  }

  // Bind loopback-only; the tunnel is the only thing that exposes it publicly.
  async start(preferredPort = 0): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => { void this.handle(req, res); });
      this.httpServer.on("error", reject);
      this.httpServer.listen(preferredPort || 0, "127.0.0.1", () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          resolve(this.port);
        } else {
          reject(new Error("Failed to bind MCP server"));
        }
      });
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((r) => this.httpServer!.close(() => r()));
      this.httpServer = undefined;
    }
    // Background processes are scoped to this server/executor and must not
    // survive a bridge stop or extension reload.
    await this.executor.dispose();
  }

  // HTTP entry point: CORS preflight, health check, /files delegation, then JSON-RPC POST.
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, PUT, DELETE, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, mcp-session-id, Range, ngrok-skip-browser-warning",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && (req.url || "").split("?")[0] === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, server: this.serverInfo }));
      return;
    }

    if (this.fileHttp && isFilesRequest(req.url, this.routeToken)) {
      await handleFilesHttp(req, res, this.fileHttp);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }

    if (this.routeToken) {
      const pathname = (req.url || "/").split("?")[0];
      if (pathname !== "/mcp/" + this.routeToken) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
    }
    // Buffer the request body with a hard size limit; destroy the socket if exceeded.
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX_REQUEST_BYTES) { aborted = true; req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => this.onBody(req, res, aborted, Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => { /* ignore client disconnect */ });
  }

  // Parse the JSON-RPC message and dispatch it.
  private async onBody(req: http.IncomingMessage, res: http.ServerResponse, aborted: boolean, body: string): Promise<void> {
    if (aborted) {
      this.respondError(res, 413, -1, "Payload too large");
      return;
    }
    let msg: any;
    try { msg = JSON.parse(body); }
    catch { this.respondError(res, 400, -32700, "Parse error"); return; }

    const sessionId = String(req.headers["mcp-session-id"] ?? "");
    const accepts = String(req.headers["accept"] ?? "").toLowerCase();
    const wantSse = accepts.includes("text/event-stream");

    // JSON-RPC notifications (no id) get a 202 and are dropped — none are handled here.
    if (msg && msg.method && (msg.id === undefined || msg.id === null)) {
      res.writeHead(202, this.corsHeaders(sessionId));
      res.end();
      return;
    }

    const id = msg?.id ?? null;
    try {
      const { result, newSessionId } = await this.dispatch(msg, sessionId);
      this.respondOk(res, id, result, wantSse, newSessionId || sessionId);
    } catch (e: any) {
      this.respondError(res, 200, id, e?.message ?? "Internal error", wantSse, sessionId);
    }
  }

  // The JSON-RPC method table.
  private async dispatch(msg: any, sessionId: string): Promise<{ result: unknown; newSessionId?: string }> {
    switch (msg?.method) {
      // initialize: mint a session id and return capabilities + instructions
      // (a file-API appendix is appended once the tunnel URL is known).
      case "initialize": {
        const sessionIdNew = sessionId || randomUUID();
        this.sessions.set(sessionIdNew, { id: sessionIdNew, createdAt: Date.now() });
        this.hooks?.onSessionCreated?.();
        const appendices: string[] = [];
        const base = this.fileHttp?.filesBaseUrl;
        if (base) {
          appendices.push(`File HTTP (same token):\nGET ${base}?op=info\nGET/PUT ${base}/<relpath>\nPOST ${base}?op=pack  POST ${base}?op=unpack&dest=.\nCall file_transfer_info for details.`);
        }
        return {
          newSessionId: sessionIdNew,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: this.serverInfo,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            instructions: this.effectiveInstructions() + (appendices.length ? `\n\n${appendices.join("\n\n")}` : ""),
          },
        };
      }
      case "ping":
        return { result: {} };
      case "tools/list":
        return { result: { tools: this.executor.listTools() } };
      // tools/call: execute the tool and report success/failure + duration via activity hooks.
      case "tools/call": {
        const name = String(msg?.params?.name ?? "");
        const args = msg?.params?.arguments ?? {};
        this.hooks?.onRequestStart?.();
        const startedAt = Date.now();
        let result: ToolCallResult;
        try {
          result = await this.executor.callTool(name, args);
        } catch (e: any) {
          this.hooks?.onRequestEnd?.({ tool: name, ok: false, durationMs: Date.now() - startedAt, args, resultText: String(e?.message ?? e) });
          throw e;
        }
        const fullText = (result.content ?? []).map((c) => c.text ?? "").join("\n");
        // Keep the activity hook cheap: never copy megabytes of output onto the UI thread.
        const resultText = fullText.length > 8192 ? fullText.slice(0, 8192) + "\u2026" : fullText;
        this.hooks?.onRequestEnd?.({ tool: name, ok: !result.isError, durationMs: Date.now() - startedAt, args, resultText });
        return { result };
      }
      case "resources/list":
        return { result: { resources: [] } };
      case "resources/read":
        throw new Error(`Resource not found: ${String(msg?.params?.uri ?? "")}`);
      case "prompts/list":
        return { result: { prompts: [] } };
      default:
        throw new Error(`Method not found: ${msg?.method}`);
    }
  }

  // Reply as JSON or as a one-shot SSE `event: message` frame (Streamable HTTP spec).
  private respondOk(res: http.ServerResponse, id: any, result: unknown, wantSse: boolean, sessionId: string): void {
    const body: JsonRpcResp = { jsonrpc: "2.0", id, result };
    if (wantSse) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        ...this.corsHeaders(sessionId),
      });
      res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      res.end();
    } else {
      res.writeHead(200, {
        "Content-Type": "application/json",
        ...this.corsHeaders(sessionId),
      });
      res.end(JSON.stringify(body));
    }
  }

  private respondError(res: http.ServerResponse, status: number, id: any, message: string, wantSse = false, sessionId = ""): void {
    const body: JsonRpcResp = { jsonrpc: "2.0", id, error: { code: -32603, message } };
    if (wantSse) {
      res.writeHead(status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        ...this.corsHeaders(sessionId),
      });
      res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`);
      res.end();
    } else {
      res.writeHead(status, {
        "Content-Type": "application/json",
        ...this.corsHeaders(sessionId),
      });
      res.end(JSON.stringify(body));
    }
  }

  // CORS is fully open: the tunnel terminates TLS and any web origin may connect.
  private corsHeaders(sessionId: string): Record<string, string> {
    const h: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "mcp-session-id",
    };
    if (sessionId) h["Mcp-Session-Id"] = sessionId;
    return h;
  }
}
