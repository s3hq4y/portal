/**
 * Error doctor — recognize known tunnel / server failures and attach an
 * actionable, localized solution card.
 */
import { TunnelError } from "./tunnel";
import { ErrorAdvice } from "../shared/types";
import { t } from "./i18n";

export interface KbEntry {
  pattern: RegExp;
  titleKey: string;
  fixKey: string;
  args?: (m: RegExpMatchArray) => string[];
  link?: string | ((m: RegExpMatchArray) => string);
}

// Ordered: specific first, generic fallbacks last.
const KB: KbEntry[] = [
  {
    pattern: /ERR_NGROK_334\b/i,
    titleKey: "adv.ngrok334.title",
    fixKey: "adv.ngrok334.fix",
    link: "https://ngrok.com/docs/errors/err_ngrok_334",
  },
  {
    pattern: /(?:ERR_NGROK_\d+|ngrok)[\s\S]{0,400}(?:authtoken|authentication token)|(?:authtoken|authentication token)[\s\S]{0,400}ngrok/i,
    titleKey: "adv.ngrokAuth.title",
    fixKey: "adv.ngrokAuth.fix",
    link: "https://dashboard.ngrok.com/get-started/your-authtoken",
  },
  {
    pattern: /Provided Tunnel token is not valid|Couldn'?t fetch tunnel token|failed to fetch tunnel credentials|tunnel credentials (?:json )?is not valid/i,
    titleKey: "adv.cfToken.title",
    fixKey: "adv.cfToken.fix",
    link: "https://one.dash.cloudflare.com/?to=/:account/networks/tunnels",
  },
  {
    pattern: /cloudflared[\s\S]{0,300}Access denied|Access denied[\s\S]{0,300}cloudflare/i,
    titleKey: "adv.cfAccess.title",
    fixKey: "adv.cfAccess.fix",
    link: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/troubleshoot-tunnels/",
  },
  {
    pattern: /EADDRINUSE|address already in use/i,
    titleKey: "adv.portBusy.title",
    fixKey: "adv.portBusy.fix",
  },
  {
    pattern: /spawn (?:ngrok|cloudflared)(?:\.exe)? ENOENT|ENOENT[^\n]{0,80}\b(?:ngrok|cloudflared)\b/i,
    titleKey: "adv.enoent.title",
    fixKey: "adv.enoent.fix",
  },
  {
    pattern: /ERR_NGROK_(\d+)\b/i,
    titleKey: "adv.ngrokGeneric.title",
    fixKey: "adv.ngrokGeneric.fix",
    args: (m) => [`ERR_NGROK_${m[1]}`],
    link: (m) => `https://ngrok.com/docs/errors/err_ngrok_${m[1]}`,
  },
];

/** Scan raw error text for the first known failure pattern. */
export function matchKnownError(text: string): ErrorAdvice | undefined {
  const s = String(text ?? "");
  if (!s.trim()) return undefined;
  for (const entry of KB) {
    const m = s.match(entry.pattern);
    if (!m) continue;
    return {
      code: entry.pattern.source.startsWith("ERR_NGROK_334")
        ? "ERR_NGROK_334"
        : m[0] && /^ERR_NGROK_\d+$/i.test(m[0])
          ? m[0].toUpperCase()
          : undefined,
      title: t(entry.titleKey, ...(entry.args ? entry.args(m) : [])),
      solution: t(entry.fixKey, ...(entry.args ? entry.args(m) : [])),
      link: typeof entry.link === "function" ? entry.link(m) : entry.link,
    };
  }
  return undefined;
}

/**
 * Best-effort advice for a thrown error: an advice explicitly attached to a
 * TunnelError wins, then the raw output it carried, then its message text.
 */
export function adviceForError(e: unknown): ErrorAdvice | undefined {
  const te = e as Partial<TunnelError> & { message?: string; raw?: string; advice?: ErrorAdvice };
  if (te && te.advice) return te.advice;
  const text = [te?.raw, te?.message].filter(Boolean).join("\n");
  return matchKnownError(text);
}
