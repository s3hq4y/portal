/**
 * File I/O for a WSL workspace when the extension host is on Windows.
 *
 * Electron/VS Code often cannot fs.stat `\\wsl.localhost\...` even though a
 * standalone node.exe can. All reads/writes go through `wsl.exe` instead.
 *
 * Do not use `bash -lc '... $1'` — a login shell plus `wsl.exe --` drops
 * positional arguments, which broke PUT (`cat > ""`).
 */
import { spawn } from "node:child_process";
import { findWslExecutable } from "../workspace-host";
import { isDenied, validateRelativePath } from "./paths";
import { SKIP_DIRS } from "../tools/workspace";

export interface WslStat {
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
}

export interface WslDirent {
  name: string;
  rel: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
}

export class WslIo {
  private readonly wsl: string;

  constructor(
    private readonly distro: string,
    private readonly posixRoot: string,
    private readonly signal?: AbortSignal,
  ) {
    const found = findWslExecutable();
    if (!found) throw new Error("wsl.exe was not found; cannot access the WSL workspace.");
    this.wsl = found;
  }

  resolvePosix(rel: string): string {
    const n = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    validateRelativePath(n);
    if (isDenied(n)) throw new Error("Path is blocked");
    const root = this.posixRoot.replace(/\/+$/, "") || "/";
    if (!n || n === ".") return root;
    const parts = n.split("/").filter((p) => p && p !== ".");
    if (parts.some((p) => p === "..")) throw new Error(`Path escapes workspace: ${rel}`);
    return root + "/" + parts.join("/");
  }

  private async checkedPath(rel: string): Promise<string> {
    const p = this.resolvePosix(rel);
    const root = this.posixRoot.replace(/\/+$/, "") || "/";
    const suffix = p.slice(root === "/" ? 1 : root.length + 1);
    let cursor = root;
    const checks = suffix.split("/").filter(Boolean).map((part) => {
      cursor = cursor.replace(/\/$/, "") + "/" + part;
      return `if [ -L ${shSingleQuote(cursor)} ]; then echo 'Path is blocked: symbolic link' >&2; exit 1; fi`;
    });
    checks.push(`if [ -e ${shSingleQuote(p)} ] && [ ! -f ${shSingleQuote(p)} ] && [ ! -d ${shSingleQuote(p)} ]; then echo 'Path is blocked: special file' >&2; exit 1; fi`);
    const result = await this.exec(["sh", "-c", "set -eu; " + checks.join("; ")]);
    if (result.code !== 0) throw new Error(cleanWslStderr(result.stderr) || "Path validation failed");
    return p;
  }

  async stat(rel: string): Promise<WslStat | null> {
    const p = await this.checkedPath(rel);
    const r = await this.exec(["stat", "-c", "%F\t%s\t%Y", "--", p]);
    if (r.code !== 0) {
      if (/No such file or directory/i.test(r.stderr)) return null;
      throw new Error(cleanWslStderr(r.stderr) || "WSL stat failed");
    }
    const line = r.stdout.toString("utf8").trim();
    const [ftype, size, y] = line.split("\t");
    if (!ftype) return null;
    return {
      kind: /directory/i.test(ftype) ? "dir" : "file",
      size: Number(size) || 0,
      mtimeMs: (Number(y) || 0) * 1000,
    };
  }

  async readFile(rel: string, maxBytes: number): Promise<Buffer> {
    const p = await this.checkedPath(rel);
    const r = await this.exec(["cat", "--", p], undefined, maxBytes + 1);
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to read ${rel}`);
    if (r.stdout.length > maxBytes) throw new Error(`File exceeds maxTransferBytes (${maxBytes})`);
    return r.stdout;
  }

  /** Read only the requested byte window, not the whole WSL file. */
  async readRange(rel: string, offset: number, length: number): Promise<Buffer> {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) throw new Error("Invalid byte range");
    const p = await this.checkedPath(rel);
    if (!length) return Buffer.alloc(0);
    const result = await this.exec(["dd", `if=${p}`, "iflag=skip_bytes,count_bytes", `skip=${offset}`, `count=${length}`, "status=none"], undefined, length);
    if (result.code !== 0) throw new Error(cleanWslStderr(result.stderr) || "WSL range read failed");
    if (result.stdout.length !== length) throw Object.assign(new Error("File changed during range read"), { statusCode: 412 });
    return result.stdout;
  }

  async writeFile(rel: string, data: Buffer, overwrite = true, condition?: { expectedSha256?: string; mustExist?: boolean }): Promise<void> {
    const p = await this.checkedPath(rel);
    const quoted = shSingleQuote(p);
    // Same-directory temporary + rename; never truncate the destination first.
    // link() provides atomic no-clobber publication when overwrite=false.
    if (condition?.expectedSha256 && !/^[a-f0-9]{64}$/.test(condition.expectedSha256)) throw new Error("Invalid expected SHA256");
    const precondition = condition?.expectedSha256
      ? `if [ ! -f ${quoted} ] || [ "$(sha256sum -- ${quoted} | cut -d ' ' -f 1)" != ${shSingleQuote(condition.expectedSha256)} ]; then echo 'Precondition failed: file changed' >&2; exit 42; fi; `
      : condition?.mustExist ? `if [ ! -f ${quoted} ]; then echo 'Precondition failed: file missing' >&2; exit 42; fi; ` : "";
    const publish = overwrite ? `mv -fT -- "$tmp" ${quoted}` : `ln -T -- "$tmp" ${quoted}`;
    const script = `set -eu; mkdir -p -- "$(dirname -- ${quoted})"; tmp=$(mktemp -- ${quoted}.portal-upload.XXXXXX); trap 'rm -f -- "$tmp"' EXIT HUP INT TERM; cat > "$tmp"; if [ -f ${quoted} ]; then chmod --reference=${quoted} "$tmp"; fi; ${precondition}${publish}`;
    const r = await this.exec(["sh", "-c", script], data, 4096);
    if (r.code === 42 || (!overwrite && /File exists/.test(r.stderr))) throw Object.assign(new Error("Precondition failed: file changed or already exists"), { statusCode: 412 });
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to write ${rel}`);
  }

  async unlink(rel: string): Promise<void> {
    const p = await this.checkedPath(rel);
    const r = await this.exec(["rm", "-f", "--", p]);
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to delete ${rel}`);
  }

  async list(relDir: string, recursive: boolean, opts?: { timeoutMs?: number; maxEntries?: number }): Promise<WslDirent[]> {
    const p = await this.checkedPath(relDir);
    const fmt = "%y\t%s\t%T@\t%P\n";
    const args = recursive
      ? // Pruned + timeout-bounded: an unpruned find over a drvfs mount (e.g.
        // /mnt/e node_modules) used to grind for minutes and starve every
        // other wsl.exe call — the whole extension appeared dead.
        ["find", p, "-mindepth", "1", ...buildPruneArgs(), "-o", "-printf", fmt]
      : ["find", p, "-mindepth", "1", "-maxdepth", "1", "-printf", fmt];
    const r = await this.exec(args, undefined, 72 * 1024 * 1024, opts?.timeoutMs ?? 20_000);
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to list ${relDir}`);
    const maxEntries = opts?.maxEntries ?? 100_000;
    const prefix = normalizeListPrefix(relDir);
    const out: WslDirent[] = [];
    for (const line of r.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [y, size, ts, ...rest] = line.split("\t");
      const name = rest.join("\t").replace(/\r$/, "");
      if (!name || (y !== "d" && y !== "f")) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      out.push({
        name: name.split("/").pop() || name,
        rel: rel.replace(/\\/g, "/"),
        kind: y === "d" ? "dir" : "file",
        size: Number(size) || 0,
        mtimeMs: (Number(ts) || 0) * 1000,
      });
      if (out.length >= maxEntries) break;
    }
    return out;
  }

  private exec(inner: string[], stdin?: Buffer, maxBytes = 72 * 1024 * 1024, timeoutMs = 30_000): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) { reject(new Error("File operation aborted")); return; }
      const child = spawn(this.wsl, ["-d", this.distro, "--", "env", "LC_ALL=C", ...inner], {
        windowsHide: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outN = 0;
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.signal?.removeEventListener("abort", abort);
        fn();
      };
      const abort = () => {
        done(() => reject(new Error("File operation aborted")));
        killWslChild(child);
      };
      // No wsl.exe call may outlive its timeout: a stuck find used to hang
      // the request forever (the caller has no other cancellation handle).
      const timer = setTimeout(() => {
        done(() => reject(new Error(`WSL operation timed out after ${timeoutMs}ms`)));
        killWslChild(child);
      }, timeoutMs);
      this.signal?.addEventListener("abort", abort, { once: true });
      if (this.signal?.aborted) abort();
      child.stdout?.on("data", (c: Buffer) => {
        outN += c.length;
        if (outN > maxBytes) {
          done(() => reject(new Error("output too large")));
          killWslChild(child);
          return;
        }
        out.push(c);
      });
      let errN = 0;
      child.stderr?.on("data", (c: Buffer) => { if (errN < 65536) { err.push(c.subarray(0, 65536 - errN)); errN += c.length; } });
      if (stdin && child.stdin) {
        child.stdin.on("error", () => { /* ignore EPIPE after early exit */ });
        child.stdin.end(stdin);
      }
      child.on("error", (e) => done(() => reject(e)));
      child.on("close", (code) => {
        done(() => resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString("utf8"),
        }));
      });
    });
  }
}

// Kill the wsl.exe session tree; plain kill() can leave the Linux-side child
// holding the 9P mount busy.
function killWslChild(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).on("error", () => { try { child.kill(); } catch { /* best effort */ } });
      return;
    }
  } catch { /* fall through */ }
  try { child.kill(); } catch { /* ignore */ }
}

/**
 * Directory pruning for recursive `find`: SKIP_DIRS + any hidden directory
 * are cut at traversal time (not filtered after the fact), matching the
 * local walker in files/http.ts. Exported for tests.
 */
export function buildPruneArgs(): string[] {
  const names = [...SKIP_DIRS];
  const inner: string[] = [];
  names.forEach((n, i) => {
    if (i > 0) inner.push("-o");
    inner.push("-name", n);
  });
  // hidden dirs (".*") as an extra alternative
  return ["(", "-type", "d", "(", ...inner, "-o", "-name", ".*", ")", "-prune", ")"];
}

function normalizeListPrefix(relDir: string): string {
  return String(relDir || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/^\.$/, "");
}

function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, `'\"'\"'`) + "'";
}

/** Drop the UTF-16 WSL localhost-forwarding banner so it does not become the error. */
export function cleanWslStderr(raw: string): string {
  return raw
    .replace(/\u0000/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/localhost/i.test(line) && !/^wsl:/i.test(line))
    .join("\n")
    .trim();
}
