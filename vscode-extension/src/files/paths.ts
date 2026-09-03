/**
 * Security layer for the HTTP file API.
 * Two defenses: (1) the DENY list for sensitive/secret files and
 * (2) the workspace jail (resolveInWorkspace) for everything else.
 */
import * as path from "node:path";
import { resolveInWorkspace } from "../tools/workspace";

// Blocked patterns: VCS internals, credentials, private keys and certificates.
const DENY = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.env($|\.)/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)id_rsa($|\.)/i,
  /\.(pem|pfx|p12|key)$/i,
];

// Forward slashes, no leading/trailing slashes.
export function normalizeRel(rel: string): string {
  return rel.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

export function isDenied(rel: string): boolean {
  const n = normalizeRel(rel);
  return DENY.some((re) => re.test(n));
}

export function resolveSafe(workspaceRoot: string, rel: string): string {
  const n = normalizeRel(rel);
  if (isDenied(n)) throw new Error(`Path is blocked: ${n || "."}`);
  return resolveInWorkspace(workspaceRoot, n || ".");
}

// Match /files/<token>/<relpath> and split off the query string.
export function parseFilesRequest(urlStr: string, token: string): { rel: string; query: URLSearchParams } | null {
  const u = new URL(urlStr, "http://127.0.0.1");
  const prefix = "/files/" + token;
  if (u.pathname !== prefix && !u.pathname.startsWith(prefix + "/")) return null;
  const rest = u.pathname.slice(prefix.length);
  const rel = decodeURIComponent(rest.replace(/^\//, ""));
  return { rel: normalizeRel(rel), query: u.searchParams };
}

// Small extension -> Content-Type map so downloads get correct types.
export function guessContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".tsx": "text/plain; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
    ".vsix": "application/octet-stream",
    ".wasm": "application/wasm",
  };
  return map[ext] ?? "application/octet-stream";
}
