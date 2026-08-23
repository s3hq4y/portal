/**
 * Path sandboxing helpers: every tool-resolved path must stay inside the
 * workspace root. Also used by the HTTP file API (files/paths.ts).
 */
import * as path from "node:path";

// Resolve + jail: throws if the result escapes the root (absolute paths, `..`).
export function resolveInWorkspace(workspaceRoot: string, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
  const rel = path.relative(workspaceRoot, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return abs;
}

// Workspace-relative, forward-slash display path.
export function relToWorkspace(workspaceRoot: string, abs: string): string {
  return path.relative(workspaceRoot, abs).replace(/\\/g, "/") || ".";
}

// Directories never descended into by the HTTP file listing/pack operations.
export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "out"]);
