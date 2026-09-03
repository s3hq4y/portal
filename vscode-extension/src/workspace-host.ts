/**
 * Resolve the VS Code workspace folder into a path Node can actually open.
 *
 * When Portal runs on Windows (extensionKind includes "ui") against a WSL
 * remote folder, `Uri.fsPath` is a POSIX path such as `/home/atlas`.
 * `path.win32.resolve` then turns that into `E:\home\atlas` — an empty
 * directory on the Windows drive, not the Linux home. Convert to
 * `\\wsl.localhost\<Distro>\...` for fs/HTTP, and keep the POSIX path
 * for `wsl.exe --cd`.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ShellKind } from "./tools/spawn";

export type WorkspaceKind = "local" | "wsl";

export interface ResolvedWorkspace {
  /** Path the host Node process should use with fs / path.win32 (UNC on Windows+WSL). */
  hostRoot: string;
  /** POSIX path inside the distro; used as `wsl.exe --cd`. */
  posixRoot?: string;
  kind: WorkspaceKind;
  wslDistro?: string;
  defaultShell: ShellKind;
}

export function resolveWorkspace(folder: vscode.WorkspaceFolder): ResolvedWorkspace {
  const uri = folder.uri;
  const remoteName = vscode.env.remoteName ?? "";
  const authority = uri.authority || "";

  const distroFromAuth = parseWslDistro(authority);
  const uncFromFs = parseWslUnc(uri.fsPath);
  const posixGuess = posixPathFromUri(uri);
  const looksPosixOnWin = process.platform === "win32" && looksLikePosixFsPath(uri.fsPath);
  const isWsl = remoteName === "wsl"
    || (uri.scheme === "vscode-remote" && /wsl/i.test(authority))
    || Boolean(uncFromFs)
    || looksPosixOnWin;

  if (process.platform === "win32" && isWsl) {
    const distro = distroFromAuth || uncFromFs?.distro || detectDefaultWslDistro();
    const posix = uncFromFs?.posix || posixGuess;
    if (distro && posix) {
      return {
        hostRoot: toWslUnc(distro, posix),
        posixRoot: posix,
        kind: "wsl",
        wslDistro: distro,
        defaultShell: "sh",
      };
    }
  }

  return {
    hostRoot: uri.fsPath,
    posixRoot: process.platform === "win32" ? undefined : uri.fsPath,
    kind: "local",
    defaultShell: process.platform === "win32" ? "powershell" : "sh",
  };
}

export function parseWslDistro(authority: string): string | undefined {
  const m = String(authority).match(/wsl\+([^/?]+)/i);
  return m ? decodeURIComponent(m[1]) : undefined;
}

export function parseWslUnc(p: string): { distro: string; posix: string } | undefined {
  const m = String(p).match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/i);
  if (!m) return undefined;
  const posix = (m[2] || "").replace(/\\/g, "/") || "/";
  return { distro: m[1], posix: posix.startsWith("/") ? posix : `/${posix}` };
}

export function looksLikePosixFsPath(p: string): boolean {
  if (!p) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;
  if (p.startsWith("\\\\")) return false;
  if (p.startsWith("/")) return true;
  // VS Code / path.win32 may turn `/home/atlas` into `\home\atlas`.
  if (p.startsWith("\\") && !p.startsWith("\\\\")) return true;
  return false;
}

export function posixPathFromUri(uri: vscode.Uri): string {
  if (uri.path && uri.path.startsWith("/")) return uri.path.replace(/\/+$/, "") || "/";
  const fs = String(uri.fsPath || "").replace(/\\/g, "/");
  if (fs.startsWith("/")) return fs.replace(/\/+$/, "") || "/";
  return ("/" + fs.replace(/^\/+/, "")).replace(/\/+$/, "") || "/";
}

export function toWslUnc(distro: string, posix: string): string {
  const rest = posix.replace(/^\/+/, "").replace(/\//g, "\\");
  return rest ? `\\\\wsl.localhost\\${distro}\\${rest}` : `\\\\wsl.localhost\\${distro}`;
}

export function findWslExecutable(): string | undefined {
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const candidates = [
    "wsl.exe",
    path.join(systemRoot, "System32", "wsl.exe"),
    path.join(systemRoot, "Sysnative", "wsl.exe"),
  ];
  const pathDirs = String(process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    for (const dir of pathDirs) {
      const full = path.join(dir.replace(/^"|"$/g, ""), candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

export function detectDefaultWslDistro(): string | undefined {
  const wsl = findWslExecutable();
  if (!wsl) return undefined;
  try {
    const raw = execFileSync(wsl, ["-l", "-q"], {
      windowsHide: true,
      timeout: 5_000,
    });
    // wsl.exe lists distros as UTF-16LE.
    const text = raw.toString("utf16le").replace(/^\uFEFF/, "");
    const lines = text
      .replace(/\0/g, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !/wsl\.exe/i.test(line));
    return lines[0];
  } catch {
    return undefined;
  }
}
