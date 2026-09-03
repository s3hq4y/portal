/**
 * Process-wide localization for the main process (mirrors the extension's
 * module-level t()). The renderer keeps its own copy; this one is used by
 * tunnel/error/bridge code paths that run in Node.
 */
import { makeT } from "../shared/l10n";

let lang: "en" | "zh" = "en";
let current = makeT("en");

export function setLanguage(l: "en" | "zh"): void {
  lang = l;
  current = makeT(l);
}

export function getLanguage(): "en" | "zh" {
  return lang;
}

export function t(key: string, ...args: Array<string | number>): string {
  return current(key, ...args);
}
