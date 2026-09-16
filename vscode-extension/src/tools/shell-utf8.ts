/**
 * UTF-8 hardening for Windows shells.
 *
 * Windows consoles default to the legacy ANSI/OEM code page (936 on Chinese systems).
 * Three independent things go wrong when a UTF-8 host such as Node reads a shell's
 * output:
 *   1. PowerShell writes stdout/stderr in the console code page unless
 *      [Console]::OutputEncoding / $OutputEncoding are changed.
 *   2. Get-Content / cat read files as ANSI unless -Encoding is given (PS 5.1).
 *   3. The whole -Command string is parsed before any statement runs, so a syntax
 *      error is reported (in ANSI) before an inline prelude can change anything.
 * cmd.exe has the same problem for batch text: a script is decoded with the code page
 * active when the file is *opened*, so `chcp` has to happen in the parent process.
 *
 * Both helpers below therefore switch encodings first and only then hand the user
 * command to the parser. They are pure functions so they can be unit tested.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const PS_PRELUDE =
  "$__u = New-Object System.Text.UTF8Encoding($false); " +
  "[Console]::InputEncoding = $__u; [Console]::OutputEncoding = $__u; $OutputEncoding = $__u; " +
  "$PSDefaultParameterValues['*:Encoding'] = 'utf8'; " +
  "$env:PYTHONIOENCODING = 'utf-8'; $env:PYTHONUTF8 = '1'; ";

/**
 * Build the -Command payload for powershell.exe / pwsh.exe.
 * The user command travels as base64(UTF-8) so it cannot be mangled by argv decoding
 * and is compiled with [ScriptBlock]::Create only after the encodings are set. Parse
 * errors are re-emitted on stderr (now UTF-8) with exit code 1; otherwise the user
 * command's own $LASTEXITCODE is propagated, and a failed last statement (for
 * example an unknown command) still yields exit code 1 like plain -Command does.
 */
export function buildPowerShellWrapperCommand(command: string): string {
  const payload = Buffer.from(command, "utf8").toString("base64");
  return (
    PS_PRELUDE +
    "try { $__c = [ScriptBlock]::Create([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + payload + "'))) } " +
    "catch { $__m = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }; $Host.UI.WriteErrorLine($__m); exit 1 }; " +
    "$__e = $Error.Count; & $__c; if ($LASTEXITCODE -ne $null) { exit $LASTEXITCODE }; if ($Error.Count -gt $__e) { exit 1 }"
  );
}

/**
 * Build the argv for cmd.exe. The user command is written to a UTF-8 batch file whose
 * first line switches the console to code page 65001. cmd.exe re-reads a batch file
 * line by line, so every line after `chcp` is decoded as UTF-8, and echo output as well
 * as built-in error messages are emitted as UTF-8. The script's exit code is propagated.
 *
 * The script lives in a private temp directory whose path contains no spaces or shell
 * metacharacters, and it is passed as the single argument after /c so that Node's
 * cmd.exe argument quoting cannot corrupt it.
 */
export function buildCmdWrapperArgs(command: string): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), "portal-cmd-"));
  const script = path.join(dir, "command.cmd");
  const body = "@echo off\r\n@chcp 65001>nul\r\n" + command + "\r\n";
  writeFileSync(script, body, { encoding: "utf8" });
  return ["/d", "/c", script];
}
