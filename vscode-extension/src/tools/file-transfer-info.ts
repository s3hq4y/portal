/**
 * file_transfer_info tool: advertises the HTTP file API (endpoints + curl
 * examples). Native tools handle text and resumable uploads; HTTP remains available for binary transfer.
 */
import { err, text, ToolModule } from "./types";

export const fileTransferInfo: ToolModule = {
  name: "file_transfer_info",
  description: "Return the public HTTP file-transfer base URL on the same tunnel (GET/PUT/POST /files/<token>/...). Prefer native read_file/write_file/apply_patch/list_files for text; use upload session tools for retryable transfers or HTTP for binary files.",
  inputSchema: { type: "object", properties: {} },
  async handle(ctx) {
    // Only available once the bridge is running (public URL known).
    if (!ctx.filesBaseUrl) return err("File transfer URL is not ready. Start Portal first.");
    const base = ctx.filesBaseUrl.replace(/\/$/, "");
    const info = {
      filesBaseUrl: base,
      maxBytes: ctx.maxTransferBytes ?? 64 * 1024 * 1024,
      note: "Send header ngrok-skip-browser-warning: 1 when calling through a free ngrok domain.",
      uploadConditions: { ifMatch: 'Use the exact quoted ETag from a GET: "<sha256>"; mismatch returns 412.', ifNoneMatch: "Use * for atomic create-only upload." },
      head: "Metadata only; no full-file hash. Complete GET returns ETag and X-File-Sha256.",
      ranges: "True byte-window reads up to 4 MiB, including WSL; X-Range-Sha256 hashes only the returned bytes. Weak range ETags cannot be used for overwrites. If-Range conservatively returns full 200.",
      nativeTools: ["read_file", "write_file", "apply_patch", "list_files", "begin_upload", "upload_chunk", "upload_status", "commit_upload", "cancel_upload"],
      encodedPathHeader: "X-File-Path is percent-encoded UTF-8; decode it before displaying.",
      limits: "File requests have a 120s default deadline. ZIP expansion is capped by maxBytes and 10000 entries. Links below the workspace root are blocked.",
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
