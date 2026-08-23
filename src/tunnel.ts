// Tunnel lifecycle: ngrok + cloudflared.
//
// We shell out via child_process.spawn (start) and child_process.execFile (probe).
// ngrok exposes a local inspection API on :4040. Cloudflare Quick Tunnel URLs are
// parsed from process output. Cloudflare Named Tunnel uses a remotely-managed
// tunnel token kept in VS Code SecretStorage and waits for both connector and
// public MCP endpoint readiness before reporting success.

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import { promisify } from "node:util";
import { CustomTunnelShell, TunnelProvider } from "./types";
import { t } from "./nls";

const execFileAsync = promisify(execFile);
const NGROK_API_DEFAULT = 4040;
const CLOUDFLARED_FALLBACK = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
const isWin = process.platform === "win32";

export class TunnelError extends Error {
  constructor(message: string, public readonly provider: TunnelProvider) { super(message); this.name = "TunnelError"; }
}

// ---------- detect / install ----------

async function execOut(cmd: string, args: string[], timeoutMs = 10_000): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(cmd, args, { windowsHide: true, timeout: timeoutMs }) as any;
}

function cloudflaredExecutable(): string {
  return isWin && existsSync(CLOUDFLARED_FALLBACK) ? CLOUDFLARED_FALLBACK : "cloudflared";
}

// Probe PATH first, then the default winget install location on Windows.
export async function detectCloudflared(): Promise<{ installed: boolean; version?: string }> {
  try {
    const r = await execOut("cloudflared", ["--version"]);
    const first = String(r.stdout || r.stderr).split(/\r?\n/)[0] ?? "";
    return { installed: true, version: first.trim() };
  } catch (e: any) {
    if (isWin) {
      try {
        const r = await execOut(CLOUDFLARED_FALLBACK, ["--version"]);
        return { installed: true, version: String(r.stdout || r.stderr).split(/\r?\n/)[0]?.trim() };
      } catch { /* fall through */ }
    }
    return { installed: false };
  }
}

// installed = binary on PATH; configValid = `ngrok config check` passes (auth set up).
export async function detectNgrok(): Promise<{ installed: boolean; version?: string; configValid: boolean; lastError?: string }> {
  let installed = false; let version: string | undefined; let configValid = false; let lastError: string | undefined;
  try {
    const r = await execOut("ngrok", ["version"]);
    installed = true;
    version = String(r.stdout || r.stderr).split(/\r?\n/)[0]?.trim() || "ngrok";
  } catch (e: any) {
    return { installed: false, configValid: false, lastError: String(e?.stderr || e?.message || e) };
  }
  try {
    await execOut("ngrok", ["config", "check"]);
    configValid = true;
  } catch (e: any) {
    configValid = false;
    lastError = String(e?.stderr || e?.message || e).split(/\r?\n/).slice(0, 3).join(" | ");
  }
  return { installed, version, configValid, lastError };
}

// Install via winget, falling back to scoop.
export async function installCloudflaredViaWinget(): Promise<void> {
  if (!isWin) throw new TunnelError(t("err.cfWinOnly"), "cloudflare-quick");
  try {
    await execOut("winget", ["install", "--id", "Cloudflare.cloudflared", "-e", "--source", "winget",
                             "--accept-package-agreements", "--accept-source-agreements"], 180_000);
    return;
  } catch (e: any) {
    // fall through to scoop
  }
  try {
    await execOut("scoop", ["install", "cloudflared"], 180_000);
  } catch (e: any) {
    throw new TunnelError(t("err.cfInstallFailed"), "cloudflare-quick");
  }
}

export async function installNgrokViaWinget(): Promise<void> {
  if (!isWin) throw new TunnelError(t("err.ngrokWinOnly"), "ngrok-reserved");
  await execOut("winget", ["install", "--id", "Ngrok.Ngrok", "-e", "--source", "winget",
                           "--accept-package-agreements", "--accept-source-agreements"], 180_000);
}

// ---------- start / stop ----------

export interface RunningTunnel {
  provider: TunnelProvider;
  publicUrl: string;
  pid: number;
  stop: () => Promise<void>;
  // cloudflared tunnels use this to update Bridge state if the connector later dies.
  onUnexpectedExit?: (listener: (detail: string) => void) => void;
}

type TunnelChild = ReturnType<typeof spawn> & { stdout: NodeJS.ReadableStream; stderr: NodeJS.ReadableStream };

// Spawn `ngrok http <port> --url <domain>` and wait for the URL in the local API.
export async function startNgrok(localPort: number, reservedDomain: string, onLog: (s: string) => void): Promise<RunningTunnel> {
  if (!reservedDomain) throw new TunnelError(t("err.ngrokDomainMissing"), "ngrok-reserved");
  const args = ["http", String(localPort), "--url", reservedDomain.replace(/^https?:\/\//i, "")];
  onLog(`[ngrok] starting: ngrok ${args.join(" ")}`);
  const child = spawn("ngrok", args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }) as unknown as TunnelChild;
  child.stdout.on("data", (b: Buffer) => onLog(`[ngrok:out] ${b.toString().trim()}`));
  child.stderr.on("data", (b: Buffer) => onLog(`[ngrok:err] ${b.toString().trim()}`));

  const publicUrl = await waitForNgrokUrl(reservedDomain, 20_000, onLog);
  return {
    provider: "ngrok-reserved",
    publicUrl,
    pid: child.pid ?? 0,
    stop: async () => killProcessTree(child, "ngrok", onLog),
  };
}

// Poll the local ngrok API until the reserved domain appears; on timeout,
// optimistically return the expected URL.
async function waitForNgrokUrl(reservedDomain: string, timeoutMs: number, onLog: (s: string) => void): Promise<string> {
  const url = `https://${reservedDomain.replace(/^https?:\/\//i, "")}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const tunnels = await fetchJson(`http://127.0.0.1:${NGROK_API_DEFAULT}/api/tunnels`, 1500);
      const found = (tunnels?.tunnels ?? []).find((x: any) => String(x?.public_url ?? "").endsWith(reservedDomain.replace(/^https?:\/\//i, "")));
      if (found) return String(found.public_url);
    } catch { /* not ready yet */ }
    await sleep(500);
  }
  onLog(`[ngrok] timeout waiting for API on :${NGROK_API_DEFAULT}; assuming ${url}`);
  return url;
}

// ---------- cloudflared ----------

type QuickProtocol = "auto" | "http2";

class QuickAttemptError extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly sawUrl: boolean,
    readonly protocol: QuickProtocol,
  ) {
    super(message);
    this.name = "QuickAttemptError";
  }
}

// A Quick Tunnel URL is allocated before cloudflared connects to an edge. Do not
// report success until BOTH the URL and "Registered tunnel connection" appear.
// If QUIC alone fails, retry once with HTTP/2; a hard TCP/7844 failure is final.
export async function startCloudflaredQuick(localPort: number, onLog: (s: string) => void): Promise<RunningTunnel> {
  let firstFailure: QuickAttemptError;
  try {
    return await startCloudflaredQuickAttempt(localPort, "auto", 30_000, onLog);
  } catch (error) {
    if (!(error instanceof QuickAttemptError)) throw error;
    firstFailure = error;
  }

  if (!shouldRetryQuickWithHttp2(firstFailure)) {
    throw new TunnelError(diagnoseQuickFailure(firstFailure.output, firstFailure.sawUrl), "cloudflare-quick");
  }

  onLog(`[cloudflared] ${t("log.cfQuickHttp2Fallback")}`);
  try {
    return await startCloudflaredQuickAttempt(localPort, "http2", 30_000, onLog);
  } catch (error) {
    if (!(error instanceof QuickAttemptError)) throw error;
    const combined = `${firstFailure.output}\n${error.output}`;
    throw new TunnelError(diagnoseQuickFailure(combined, firstFailure.sawUrl || error.sawUrl), "cloudflare-quick");
  }
}

async function startCloudflaredQuickAttempt(
  localPort: number,
  protocol: QuickProtocol,
  timeoutMs: number,
  onLog: (s: string) => void,
): Promise<RunningTunnel> {
  const args = ["tunnel", "--url", `http://127.0.0.1:${localPort}`, "--no-autoupdate"];
  if (protocol === "http2") args.push("--protocol", "http2");
  const label = protocol === "http2" ? "cloudflared:http2" : "cloudflared";
  onLog(`[${label}] starting: cloudflared ${args.join(" ")}`);
  const child = spawn(cloudflaredExecutable(), args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as TunnelChild;

  let url = "";
  let output = "";
  let ready = false;
  let settled = false;
  let stopping = false;
  let unexpectedListener: ((detail: string) => void) | undefined;
  let pendingUnexpectedExit: string | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: QuickAttemptError) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const succeedIfReady = () => {
    if (!settled && url && /Registered tunnel connection/i.test(output)) {
      settled = true;
      ready = true;
      resolveReady();
    }
  };
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    rejectReady(new QuickAttemptError(message, output, Boolean(url), protocol));
  };
  const consume = (kind: "out" | "err", b: Buffer) => {
    const chunk = b.toString();
    output = (output + chunk).slice(-65_536); // Handles markers split across chunks.
    onLog(`[${label}:${kind}] ${chunk.trim()}`);
    const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !url) url = match[0];
    succeedIfReady();
    if (/precheck complete[^\r\n]*hard_fail=true/i.test(output) || /Environment has critical failures/i.test(output)) {
      fail("connectivity pre-check failed");
    } else if (protocol === "http2" && /TLS handshake with edge error|HTTP\/2 connection is blocked or unreachable/i.test(output)) {
      fail("HTTP/2 edge connection failed");
    }
  };

  child.stdout.on("data", (b: Buffer) => consume("out", b));
  child.stderr.on("data", (b: Buffer) => consume("err", b));
  child.once("error", (error: Error) => fail(error.message));
  child.once("exit", (code, signal) => {
    const detail = `exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`;
    if (!ready) {
      fail(detail);
    } else if (!stopping) {
      pendingUnexpectedExit = detail;
      unexpectedListener?.(detail);
    }
  });

  const timeout = setTimeout(() => fail(`timeout after ${timeoutMs}ms`), timeoutMs);
  try {
    await readyPromise;
    clearTimeout(timeout);
    onLog(`[${label}] ${t("log.cfQuickReady", url)}`);
  } catch (error) {
    clearTimeout(timeout);
    stopping = true;
    await killProcessTree(child, label, onLog);
    throw error;
  }

  return {
    provider: "cloudflare-quick",
    publicUrl: url,
    pid: child.pid ?? 0,
    stop: async () => {
      stopping = true;
      await killProcessTree(child, label, onLog);
    },
    onUnexpectedExit: (listener) => {
      unexpectedListener = listener;
      if (pendingUnexpectedExit) queueMicrotask(() => listener(pendingUnexpectedExit!));
    },
  };
}

function shouldRetryQuickWithHttp2(error: QuickAttemptError): boolean {
  const text = error.output;
  const tcpBlocked = /TCP Connectivity\s+[^\r\n]*FAIL|HTTP\/2 connection is blocked or unreachable|Allow outbound TCP on port 7844/i.test(text);
  if (tcpBlocked) return false;
  return error.sawUrl || /QUIC|UDP Connectivity\s+[^\r\n]*FAIL/i.test(text);
}

/** Convert noisy cloudflared output into an actionable, localized start error. */
export function diagnoseQuickFailure(output: string, sawUrl: boolean): string {
  const fakeIp = /\bip=198\.(?:18|19)\./i.test(output);
  const tcpBlocked = /TCP Connectivity\s+[^\r\n]*FAIL|HTTP\/2 connection is blocked or unreachable|Allow outbound TCP on port 7844/i.test(output);
  const udpBlocked = /UDP Connectivity\s+[^\r\n]*FAIL|Failed to dial a quic connection|Allow outbound QUIC traffic on port 7844/i.test(output);
  const proxyTlsFailure = /TLS handshake with edge error|Serve tunnel error[^\r\n]*TLS handshake/i.test(output);
  if (fakeIp && (tcpBlocked || udpBlocked || proxyTlsFailure)) return t("err.cfQuickClashFakeIp");
  if (tcpBlocked && udpBlocked) return t("err.cfQuickPort7844Blocked");
  if (proxyTlsFailure) return t("err.cfQuickProxyTls");
  if (udpBlocked) return t("err.cfQuickQuicFailed");
  if (!sawUrl) return t("err.cfNoUrl");
  const tail = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-3).join(" | ");
  return t("err.cfQuickNotReady", tail || t("err.cfNamedNoOutput"));
}

/** Normalize and validate a user-facing Cloudflare public hostname. */
export function normalizeCloudflareHostname(value: string): string {
  const hostname = value.trim().replace(/^https?:\/\//i, "").replace(/\.$/, "").toLowerCase();
  if (!hostname || hostname.length > 253 || hostname.includes("/") || hostname.includes(":") || hostname.includes("?")) {
    throw new TunnelError(t("err.cfHostnameInvalid"), "cloudflare-named");
  }
  const labels = hostname.split(".");
  if (labels.length < 2 || labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new TunnelError(t("err.cfHostnameInvalid"), "cloudflare-named");
  }
  return hostname;
}

/** Basic shape validation only; Cloudflare remains the authority on token validity. */
export function validateCloudflareTunnelToken(value: string): string {
  const token = value.trim();
  if (token.length < 32 || /\s/.test(token)) throw new TunnelError(t("err.cfTokenInvalid"), "cloudflare-named");
  return token;
}

/**
 * Start a remotely-managed Cloudflare Named Tunnel.
 *
 * The tunnel token is passed only via TUNNEL_TOKEN (never argv/logs). Its public
 * hostname and ingress service are configured in Cloudflare. Since that ingress
 * targets localhost, Named mode requires a fixed local MCP port. Startup is only
 * successful after cloudflared registers a connector and the public MCP route
 * responds with the server's expected GET=405 behavior.
 */
export async function startCloudflaredNamed(
  localPort: number,
  hostnameInput: string,
  tunnelTokenInput: string,
  mcpPath: string,
  onLog: (s: string) => void,
): Promise<RunningTunnel> {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new TunnelError(t("err.cfFixedPortRequired"), "cloudflare-named");
  }
  const hostname = normalizeCloudflareHostname(hostnameInput);
  const tunnelToken = validateCloudflareTunnelToken(tunnelTokenInput);
  const publicUrl = `https://${hostname}`;
  const args = ["tunnel", "--no-autoupdate", "--loglevel", "info", "run"];
  onLog(`[cloudflared:named] starting connector for ${hostname} -> http://127.0.0.1:${localPort}`);

  const child = spawn(cloudflaredExecutable(), args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, TUNNEL_TOKEN: tunnelToken },
  }) as unknown as TunnelChild;

  let stopping = false;
  let ready = false;
  let output = "";
  let unexpectedListener: ((detail: string) => void) | undefined;
  let pendingUnexpectedExit: string | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const consume = (kind: "out" | "err", b: Buffer) => {
    const raw = b.toString();
    const safe = raw.split(tunnelToken).join("[REDACTED]");
    output = (output + safe).slice(-32_768);
    onLog(`[cloudflared:named:${kind}] ${safe.trim()}`);
    if (!ready && /Registered tunnel connection/i.test(output)) {
      ready = true;
      resolveReady();
    }
  };
  child.stdout.on("data", (b: Buffer) => consume("out", b));
  child.stderr.on("data", (b: Buffer) => consume("err", b));
  child.once("error", (error: Error) => {
    if (!ready) rejectReady(new TunnelError(t("err.cfNamedExited", error.message), "cloudflare-named"));
  });
  child.once("exit", (code, signal) => {
    const detail = `exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""}`;
    if (!ready) {
      rejectReady(new TunnelError(t("err.cfNamedExited", detail), "cloudflare-named"));
    } else if (!stopping) {
      pendingUnexpectedExit = detail;
      unexpectedListener?.(detail);
    }
  });

  const timeout = setTimeout(() => {
    if (!ready) {
      const tail = output.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ");
      rejectReady(new TunnelError(t("err.cfNamedTimeout", tail || t("err.cfNamedNoOutput")), "cloudflare-named"));
    }
  }, 30_000);

  try {
    await readyPromise;
    clearTimeout(timeout);
    onLog(`[cloudflared:named] connector registered; checking ${publicUrl}/mcp/[REDACTED]`);
    await waitForNamedMcpEndpoint(`${publicUrl}${mcpPath}`, 35_000, onLog);
  } catch (error) {
    clearTimeout(timeout);
    stopping = true;
    await killProcessTree(child, "cloudflared:named", onLog);
    throw error;
  }

  return {
    provider: "cloudflare-named",
    publicUrl,
    pid: child.pid ?? 0,
    stop: async () => {
      stopping = true;
      await killProcessTree(child, "cloudflared:named", onLog);
    },
    onUnexpectedExit: (listener) => {
      unexpectedListener = listener;
      if (pendingUnexpectedExit) queueMicrotask(() => listener(pendingUnexpectedExit!));
    },
  };
}

// ---------- custom ----------

// The extensibility escape hatch: bring any tunnel client (or none at all).
//
// The command is a template with {{port}} / {{token}} / {{workspace}} placeholders
// and runs in the configured shell. The public URL is either fixed
// (customTunnelUrl) or extracted from process output with customTunnelUrlPattern
// (default: the first http(s) URL that is not localhost). An optional
// readyPattern gates readiness; with a fixed URL and no readyPattern, success is
// reported after a short dwell with the child still alive. With no command at
// all ("attach mode") the fixed URL is adopted as-is, which covers tunnels
// managed outside VS Code (system services, routers, dedicated boxes, ...).
export interface CustomTunnelOptions {
  command: string;
  shell: CustomTunnelShell;
  url: string;
  urlPattern?: string;
  readyPattern?: string;
  startupTimeoutMs: number;
  workspaceRoot?: string;
}

// How long a fixed-URL custom tunnel must stay alive before we trust it.
const CUSTOM_DWELL_MS = 1_500;

/** Compile a user-supplied regex, or return undefined for an empty one. */
function compileCustomRegex(source: string): RegExp | undefined {
  const s = source.trim();
  if (!s) return undefined;
  try {
    return new RegExp(s, "i");
  } catch (e: any) {
    throw new TunnelError(t("err.customBadPattern", `${s} (${e?.message ?? e})`), "custom");
  }
}

/**
 * Find the public URL in accumulated output. A user pattern may capture the
 * URL in group 1 (group 1 wins when present); the default accepts any http(s)
 * URL that is not localhost. Returns undefined while nothing plausible exists.
 */
function extractCustomUrl(output: string, pattern?: string): string | undefined {
  const re = pattern?.trim() ? new RegExp(pattern, "gi") : /https?:\/\/[^\s"'<>\\]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const u = (m[1] ?? m[0]).trim().replace(/\/+$/, "");
    if (!u) continue;
    if (/^(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::|\b)/i.test(u)) continue;
    return u;
  }
  return undefined;
}

/** Map the customTunnelShell setting onto a concrete spawn invocation. */
function customShellSpec(shell: CustomTunnelShell, cmdline: string): { file: string; args: string[]; shell?: boolean } {
  switch (shell) {
    case "powershell": return { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmdline] };
    case "pwsh": return { file: "pwsh", args: ["-NoProfile", "-Command", cmdline] };
    case "cmd": return isWin ? { file: "cmd.exe", args: ["/d", "/s", "/c", cmdline] } : { file: cmdline, args: [], shell: true };
    case "bash": return { file: "bash", args: ["-c", cmdline] };
    default: return { file: cmdline, args: [], shell: true };
  }
}

export async function startCustomTunnel(
  localPort: number,
  opts: CustomTunnelOptions,
  routeToken: string,
  onLog: (s: string) => void,
): Promise<RunningTunnel> {
  const command = opts.command.trim();
  const fixedUrl = opts.url.trim().replace(/\/+$/, "");
  if (!command && !fixedUrl) throw new TunnelError(t("err.customCommandRequired"), "custom");
  if (fixedUrl && !/^https?:\/\//i.test(fixedUrl)) throw new TunnelError(t("err.customUrlInvalid"), "custom");

  // Attach mode: the tunnel already runs elsewhere; adopt the URL, nothing to spawn.
  if (!command) {
    onLog(`[custom] ${t("log.customAttach", fixedUrl)}`);
    return { provider: "custom", publicUrl: fixedUrl, pid: 0, stop: async () => { /* externally managed */ } };
  }

  const readyRegex = compileCustomRegex(opts.readyPattern ?? "");
  const timeoutMs = Math.max(5_000, opts.startupTimeoutMs || 30_000);
  const cmdline = command
    .replace(/\{\{port\}\}/gi, String(localPort))
    .replace(/\{\{token\}\}/gi, routeToken)
    .replace(/\{\{workspace\}\}/gi, opts.workspaceRoot ?? "");
  const spec = customShellSpec(opts.shell, cmdline);
  // The route token is a credential; keep it out of the log line.
  const redacted = routeToken ? cmdline.split(routeToken).join("[REDACTED]") : cmdline;
  onLog(`[custom] shell=${opts.shell}; ${t("log.customStarting")}: ${redacted}`);

  const child = spawn(spec.file, spec.args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    ...(spec.shell ? { shell: true } : {}),
  }) as unknown as TunnelChild;

  const startedAt = Date.now();
  let url = fixedUrl;
  let output = "";
  let ready = false;
  let settled = false;
  let stopping = false;
  let unexpectedListener: ((detail: string) => void) | undefined;
  let pendingUnexpectedExit: string | undefined;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

  const tail = () => output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ") || "no output";
  const succeedIfReady = () => {
    if (settled) return;
    if (!url) url = extractCustomUrl(output, opts.urlPattern) ?? "";
    if (!url) return;
    if (readyRegex) {
      if (readyRegex.test(output)) { settled = true; ready = true; resolveReady(); }
      return;
    }
    if (fixedUrl) {
      // Fixed URL + no marker: dwell briefly so an instantly dying child still
      // fails instead of reporting success on a dead tunnel.
      if (Date.now() - startedAt >= CUSTOM_DWELL_MS) { settled = true; ready = true; resolveReady(); }
      return;
    }
    settled = true; ready = true; resolveReady();
  };
  const fail = (message: string) => {
    if (settled) return;
    settled = true;
    rejectReady(new TunnelError(t("err.customFailed", message), "custom"));
  };
  const consume = (kind: "out" | "err", b: Buffer) => {
    const chunk = b.toString();
    output = (output + chunk).slice(-65_536);
    onLog(`[custom:${kind}] ${chunk.trim()}`);
    succeedIfReady();
  };
  child.stdout.on("data", (b: Buffer) => consume("out", b));
  child.stderr.on("data", (b: Buffer) => consume("err", b));
  child.once("error", (error: Error) => fail(error.message));
  child.once("exit", (code, signal) => {
    const detail = `exit=${code ?? "null"}${signal ? ` signal=${signal}` : ""} ${tail()}`;
    if (!ready) fail(detail);
    else if (!stopping) { pendingUnexpectedExit = detail; unexpectedListener?.(detail); }
  });

  // Re-evaluate periodically: the dwell path advances without new output.
  const dwellTimer = setInterval(succeedIfReady, 250);
  const timeout = setTimeout(() => fail(t("err.customTimeout", `${timeoutMs}ms`, tail())), timeoutMs);
  try {
    await readyPromise;
    clearTimeout(timeout); clearInterval(dwellTimer);
    onLog(`[custom] ${t("log.customReady", url)}`);
  } catch (error) {
    clearTimeout(timeout); clearInterval(dwellTimer);
    stopping = true;
    await killProcessTree(child, "custom", onLog);
    throw error;
  }

  return {
    provider: "custom",
    publicUrl: url.replace(/\/+$/, ""),
    pid: child.pid ?? 0,
    stop: async () => { stopping = true; await killProcessTree(child, "custom", onLog); },
    onUnexpectedExit: (listener) => {
      unexpectedListener = listener;
      if (pendingUnexpectedExit) queueMicrotask(() => listener(pendingUnexpectedExit!));
    },
  };
}

// ---------- helpers ----------

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function killProcessTree(child: TunnelChild, label: string, onLog: (s: string) => void): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (isWin && child.pid) {
    try {
      await execOut("taskkill", ["/PID", String(child.pid), "/T", "/F"], 5_000);
      onLog(`[${label}] taskkilled pid=${child.pid}`);
      return;
    } catch { /* fall through to child.kill() */ }
  }
  try { child.kill(); onLog(`[${label}] killed pid=${child.pid}`); } catch { /* ignore */ }
}

async function waitForNamedMcpEndpoint(url: string, timeoutMs: number, onLog: (s: string) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = t("err.cfNamedNoOutput");
  while (Date.now() < deadline) {
    try {
      const status = await getHttpsStatus(url, 4_000);
      last = `HTTP ${status}`;
      // A valid MCP endpoint rejects GET in this server implementation.
      if (status === 405) {
        onLog(`[cloudflared:named] public MCP endpoint ready (${status})`);
        return;
      }
    } catch (error: any) {
      last = error?.message ?? String(error);
    }
    await sleep(1_250);
  }
  throw new TunnelError(t("err.cfNamedHealth", last), "cloudflare-named");
}

function getHttpsStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      timeout: timeoutMs,
      headers: { "user-agent": "Portal/1.0.0", accept: "application/json, text/event-stream" },
    }, (res) => {
      const status = res.statusCode ?? 0;
      res.once("end", () => resolve(status));
      res.resume();
    });
    req.once("timeout", () => req.destroy(new Error("timeout")));
    req.once("error", reject);
  });
}

// Tiny promise-wrapped http.get with timeout (no fetch in older Node).
function fetchJson(url: string, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (error) { reject(error); }
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}
