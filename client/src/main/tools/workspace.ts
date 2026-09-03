/**
 * Path sandboxing helpers: every tool-resolved path must stay inside the
 * workspace root. Also used by the HTTP file API (files/paths.ts).
 */
import * as nodePath from "node:path";

function pathFor(root: string): typeof nodePath.posix | typeof nodePath.win32 {
  if (process.platform !== "win32") return nodePath.posix;
  if (root.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(root)) return nodePath.win32;
  return nodePath.posix;
}

// Resolve + jail: throws if the result escapes the root (absolute paths, `..`).
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const path = pathFor(workspaceRoot);
  const abs = path.isAbsolute(p) ? path.normalize(p) : path.resolve(workspaceRoot, p);
  const rel = path.relative(workspaceRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

// Workspace-relative, forward-slash display path.
export function relToWorkspace(workspaceRoot: string, abs: string): string {
  const path = pathFor(workspaceRoot);
  return path.relative(workspaceRoot, abs).replace(/\\/g, "/") || ".";
}

// Directories never descended into by the HTTP file listing/pack operations.
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out"]);

/** Map a host (UNC / drive) absolute path back to the POSIX path inside WSL. */
export function hostPathToPosix(hostRoot: string, posixRoot: string, absHost: string): string {
  const rel = pathFor(hostRoot).relative(hostRoot, absHost).replace(/\\/g, "/");
  if (!rel || rel === ".") return posixRoot;
  if (rel.startsWith("..")) return posixRoot;
  return posixRoot.replace(/\/+$/, "") + "/" + rel;
}
