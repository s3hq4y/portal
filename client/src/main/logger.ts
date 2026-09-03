/**
 * In-memory ring-buffer log (replaces the VS Code output channel) that also
 * mirrors to the console and fans out to subscribers.
 */
import { EventEmitter } from "node:events";
import type { LogEntry } from "../shared/types";

const MAX_LOG = 500;

export class Logger {
  private logs: LogEntry[] = [];
  private readonly events = new EventEmitter();

  log(level: LogEntry["level"], message: string): void {
    const entry: LogEntry = { ts: Date.now(), level, message };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG) this.logs.splice(0, this.logs.length - MAX_LOG);
    const tag = level.toUpperCase().padEnd(5);
    const line = `[${new Date(entry.ts).toISOString()}] ${tag} ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
    this.events.emit("entry", entry);
  }

  getLogs(): readonly LogEntry[] {
    return this.logs;
  }

  clear(): void {
    this.logs = [];
    this.events.emit("clear");
  }

  onLog(fn: (entry: LogEntry) => void): () => void {
    const handler = (entry: LogEntry) => fn(entry);
    this.events.on("entry", handler);
    return () => {
      this.events.off("entry", handler);
    };
  }

  onClear(fn: () => void): () => void {
    const handler = () => fn();
    this.events.on("clear", handler);
    return () => {
      this.events.off("clear", handler);
    };
  }
}
