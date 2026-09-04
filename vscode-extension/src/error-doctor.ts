/**
 * Error doctor — recognize known tunnel / server failures and attach an
 * actionable, localized solution card.
 *
 * The knowledge base matches raw error text (tunnel stderr, exception
 * messages, unexpected-exit tails). Every `ERR_NGROK_<code>` falls back to a
 * generic card that links the official error page; well-known codes and
 * vendor phrases get tailored fixes. UI surfaces (sidebar + settings page)
 * render the returned ErrorAdvice next to the error state.
 */
import { TunnelError } from "./tunnel";
import { ErrorAdvice } from "./types";
import { t } from "./nls";

interface KbEntry {
  pattern: RegExp;
  titleKey: string;
  fixKey: string;
  args?: (m: RegExpMatchArray) => string[];
  link?: string | ((m: RegExpMatchArray) => string);
}

// Ordered: specific first, generic fallbacks last.
const KB: KbEntry[] = [
  {
    // ngrok 334 — the exact scenario users hit after an unclean shutdown:
    // the previous agent session still holds the reserved domain.
    pattern: /ERR_NGROK_334\b/i,
    titleKey: "adv.ngrok334.title",
    fixKey: "adv.ngrok334.fix",
    link: "https://ngrok.com/docs/errors/err_ngrok_334",
  },
  {
    // ngrok 320 — the reserved domain lives on a different account than the
    // authtoken in use (almost always a --config file of the wrong account).
    pattern: /ERR_NGROK_320\b/i,
    titleKey: "adv.ngrok320.title",
    fixKey: "adv.ngrok320.fix",
    link: "https://ngrok.com/docs/errors/err_ngrok_320",
  },
  {
    // ngrok auth problems (message mentions the authtoken regardless of code).
    pattern: /(?:ERR_NGROK_\d+|ngrok)[\s\S]{0,400}(?:authtoken|authentication token)|(?:authtoken|authentication token)[\s\S]{0,400}ngrok/i,
    titleKey: "adv.ngrokAuth.title",
    fixKey: "adv.ngrokAuth.fix",
    link: "https://dashboard.ngrok.com/get-started/your-authtoken",
  },
  {
    // Cloudflare rejects an invalid / refreshed connector token.
    pattern: /Provided Tunnel token is not valid|Couldn'?t fetch tunnel token|failed to fetch tunnel credentials|tunnel credentials (?:json )?is not valid/i,
    titleKey: "adv.cfToken.title",
    fixKey: "adv.cfToken.fix",
    link: "https://one.dash.cloudflare.com/?to=/:account/networks/tunnels",
  },
  {
    // Cloudflare refuses the connector itself.
    pattern: /cloudflared[\s\S]{0,300}Access denied|Access denied[\s\S]{0,300}cloudflare/i,
    titleKey: "adv.cfAccess.title",
    fixKey: "adv.cfAccess.fix",
    link: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/troubleshoot-tunnels/",
  },
  {
    // The local MCP port is taken.
    pattern: /EADDRINUSE|address already in use/i,
    titleKey: "adv.portBusy.title",
    fixKey: "adv.portBusy.fix",
  },
  {
    // Tunnel binary missing from PATH.
    pattern: /spawn (?:ngrok|cloudflared)(?:\.exe)? ENOENT|ENOENT[^\n]{0,80}\b(?:ngrok|cloudflared)\b/i,
    titleKey: "adv.enoent.title",
    fixKey: "adv.enoent.fix",
  },
  {
    // Generic ngrok: any other ERR_NGROK_<code> still gets the official page.
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
        : m[0] && /^ERR_NGROK_\d+$/i.test(m[0]) ? m[0].toUpperCase() : undefined,
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
