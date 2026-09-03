/**
 * Secret storage for the Cloudflare Tunnel token (mirrors VS Code
 * SecretStorage). Uses Electron safeStorage (DPAPI on Windows) so the token
 * never sits on disk in plaintext; falls back to a base64 placeholder when
 * encryption is unavailable.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { app, safeStorage } from "electron";

const FILE = () => path.join(app.getPath("userData"), "portal-secrets.json");

interface SecretsFile {
  cloudflareTunnelToken?: string; // "enc:<base64>" or "b64:<base64>"
}

function readFile(): SecretsFile {
  try {
    return JSON.parse(fs.readFileSync(FILE(), "utf8")) as SecretsFile;
  } catch {
    return {};
  }
}

function writeFile(data: SecretsFile): void {
  try {
    fs.mkdirSync(path.dirname(FILE()), { recursive: true });
    fs.writeFileSync(FILE(), JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Failed to persist secrets:", e);
  }
}

export async function getCloudflareToken(): Promise<string | undefined> {
  const data = readFile();
  const value = data.cloudflareTunnelToken;
  if (!value) return undefined;
  try {
    if (value.startsWith("enc:")) {
      if (safeStorage.isEncryptionAvailable()) {
        const buf = safeStorage.decryptString(Buffer.from(value.slice(4), "base64"));
        return buf || undefined;
      }
      return undefined;
    }
    if (value.startsWith("b64:")) return Buffer.from(value.slice(4), "base64").toString("utf8");
    return undefined;
  } catch {
    return undefined;
  }
}

export async function setCloudflareToken(token: string): Promise<void> {
  const data = readFile();
  if (safeStorage.isEncryptionAvailable()) {
    const enc = safeStorage.encryptString(token).toString("base64");
    data.cloudflareTunnelToken = `enc:${enc}`;
  } else {
    // No OS keychain: store obfuscated (still better than nothing) and warn.
    console.warn("safeStorage unavailable — Cloudflare token stored with weak obfuscation.");
    data.cloudflareTunnelToken = `b64:${Buffer.from(token, "utf8").toString("base64")}`;
  }
  writeFile(data);
}

export async function clearCloudflareToken(): Promise<void> {
  const data = readFile();
  delete data.cloudflareTunnelToken;
  writeFile(data);
}
