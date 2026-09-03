/**
 * file_transfer_info tool: advertises the HTTP file API (endpoints + curl examples).
 * This is the ONLY way to read/write files through Portal.
 */
import { err, text, ToolModule } from "./types";

export const fileTransferInfo: ToolModule = {
  name: "file_transfer_info",
  description:
    "Return the public HTTP file-transfer base URL on the same tunnel (GET/PUT/POST /files/<token>/...). File read/write tools are intentionally not exposed by this server; use this HTTP API for all files, binary or text.",
  inputSchema: { type: "object", properties: {} },
  async handle(ctx) {
    // Only available once the bridge is running (public URL known).
    if (!ctx.filesBaseUrl) return err("File transfer URL is not ready. Start Portal first.");
    const base = ctx.filesBaseUrl.replace(/\/$/, "");
    const info = {
      filesBaseUrl: base,
      maxBytes: ctx.maxTransferBytes ?? 64 * 1024 * 1024,
      note: "Send header ngrok-skip-browser-warning: 1 when calling through a free ngrok domain.",
      endpoints: {
        info: `GET ${base}?op=info`,
        list: `GET ${base}?glob=**/*`,
        download: `GET ${base}/<relpath>`,
        head: `HEAD ${base}/<relpath>`,
        upload: `PUT ${base}/<relpath>`,
        delete: `DELETE ${base}/<relpath>`,
        pack: `POST ${base}?op=pack   JSON body {"paths":["src"]}`,
        unpack: `POST ${base}?op=unpack&dest=.   raw zip body`,
      },
      examples: {
        curlDownload: `curl -fsSL -H "ngrok-skip-browser-warning: 1" "${base}/README.md" -o README.md`,
        curlUpload: `curl -fsSL -H "ngrok-skip-browser-warning: 1" -T ./photo.png "${base}/incoming/photo.png"`,
        curlPack: `curl -fsSL -H "ngrok-skip-browser-warning: 1" -H "Content-Type: application/json" -d "{\\"paths\\":[\\"src\\"]}" "${base}?op=pack" -o src.zip`,
      },
    };
    return text(JSON.stringify(info, null, 2));
  },
};
