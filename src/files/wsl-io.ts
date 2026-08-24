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
  ) {
    const found = findWslExecutable();
    if (!found) throw new Error("wsl.exe was not found; cannot access the WSL workspace.");
    this.wsl = found;
  }

  resolvePosix(rel: string): string {
    const n = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    const root = this.posixRoot.replace(/\/+$/, "") || "/";
    if (!n || n === ".") return root;
    const parts = n.split("/").filter((p) => p && p !== ".");
    if (parts.some((p) => p === "..")) throw new Error(`Path escapes workspace: ${rel}`);
    return root + "/" + parts.join("/");
  }

  async stat(rel: string): Promise<WslStat | null> {
    const p = this.resolvePosix(rel);
    const r = await this.exec(["stat", "-c", "%F\t%s\t%Y", "--", p]);
    if (r.code !== 0) return null;
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
    const p = this.resolvePosix(rel);
    const r = await this.exec(["cat", "--", p], undefined, maxBytes + 1);
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to read ${rel}`);
    if (r.stdout.length > maxBytes) throw new Error(`File exceeds maxTransferBytes (${maxBytes})`);
    return r.stdout;
  }

  async writeFile(rel: string, data: Buffer): Promise<void> {
    const p = this.resolvePosix(rel);
    const quoted = shSingleQuote(p);
    const script = `mkdir -p -- "$(dirname -- ${quoted})" && cat > ${quoted}`;
    const r = await this.exec(["sh", "-c", script], data, 4096);
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to write ${rel}`);
  }

  async unlink(rel: string): Promise<void> {
    const p = this.resolvePosix(rel);
    const r = await this.exec(["rm", "-f", "--", p]);
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to delete ${rel}`);
  }

  async list(relDir: string, recursive: boolean): Promise<WslDirent[]> {
    const p = this.resolvePosix(relDir);
    const fmt = recursive
      ? ["find", p, "-mindepth", "1", "-printf", "%y\t%s\t%T@\t%P\n"]
      : ["find", p, "-mindepth", "1", "-maxdepth", "1", "-printf", "%y\t%s\t%T@\t%f\n"];
    const r = await this.exec(fmt);
    if (r.code !== 0) throw new Error(cleanWslStderr(r.stderr) || `Failed to list ${relDir}`);
    const prefix = normalizeListPrefix(relDir);
    const out: WslDirent[] = [];
    for (const line of r.stdout.toString("utf8").split("\n")) {
      if (!line) continue;
      const [y, size, ts, ...rest] = line.split("\t");
      const name = rest.join("\t").replace(/\r$/, "");
      if (!name) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      out.push({
        name: name.split("/").pop() || name,
        rel: rel.replace(/\\/g, "/"),
        kind: y === "d" ? "dir" : "file",
        size: Number(size) || 0,
        mtimeMs: (Number(ts) || 0) * 1000,
      });
    }
    return out;
  }

  private exec(inner: string[], stdin?: Buffer, maxBytes = 72 * 1024 * 1024): Promise<{ code: number; stdout: Buffer; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.wsl, ["-d", this.distro, "--", ...inner], {
        windowsHide: true,
        stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let outN = 0;
      child.stdout?.on("data", (c: Buffer) => {
        outN += c.length;
        if (outN > maxBytes) {
          child.kill();
          reject(new Error("output too large"));
          return;
        }
        out.push(c);
      });
      child.stderr?.on("data", (c: Buffer) => err.push(c));
      if (stdin && child.stdin) {
        child.stdin.on("error", () => { /* ignore EPIPE after early exit */ });
        child.stdin.end(stdin);
      }
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({
          code: code ?? 1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      });
    });
  }
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
