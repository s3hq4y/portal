// End-to-end check that Windows shells launched through the UTF-8 wrappers return
// readable Chinese on stdout AND stderr, for parse errors, runtime errors, file reads,
// native tools, and exit codes. Run: node src/tools/shell-utf8.test.mjs
// Skips (exit 0) on non-Windows hosts.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

if (process.platform !== "win32") { console.log("skip: not win32"); process.exit(0); }
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Prefer compiled output when present (client: dist/), otherwise transpile the TS on the fly.
let mod;
try { mod = require(path.join(here, "shell-utf8.js")); }
catch {
  const ts = require("typescript");
  const src = require("node:fs").readFileSync(path.join(here, "shell-utf8.ts"), "utf8");
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const m = { exports: {} }; new Function("module", "exports", "require", js)(m, m.exports, require); mod = m.exports;
}
const { buildPowerShellWrapperCommand, buildCmdWrapperArgs } = mod;

const dir = mkdtempSync(path.join(tmpdir(), "shell-utf8-test-"));
const file = path.join(dir, "中文.txt");
writeFileSync(file, "中文测试：你好，世界！— probe ✓\n", "utf8");
const has = (exe) => spawnSync("where.exe", [exe], { encoding: "utf8" }).status === 0;
const run = (exe, args) => spawnSync(exe, args, { encoding: "utf8", cwd: dir, windowsHide: true });
const psArgs = (cmd) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", buildPowerShellWrapperCommand(cmd)];

const cases = [];
for (const exe of ["powershell.exe", "pwsh.exe"]) {
  if (!has(exe)) { console.log("skip: " + exe + " not installed"); continue; }
  cases.push([exe + " stdout+Get-Content", () => run(exe, psArgs(`Get-Content '${file}'; Write-Output '直接输出中文'`)), (r) => r.status === 0 && r.stdout.includes("中文测试：你好，世界！— probe ✓") && r.stdout.includes("直接输出中文")]);
  cases.push([exe + " runtime error", () => run(exe, psArgs(`Write-Error '运行期错误中文'; nonexist-命令`)), (r) => r.stderr.includes("运行期错误中文") && r.stderr.includes("nonexist-命令") && !/\uFFFD/.test(r.stderr)]);
  cases.push([exe + " parse error", () => run(exe, psArgs(`Write-Output '解析错误前' ||| x`)), (r) => r.status === 1 && r.stderr.includes("解析错误前") && !/\uFFFD/.test(r.stderr)]);
  cases.push([exe + " exit code", () => run(exe, psArgs(`Write-Output '中文'; cmd /c exit 7`)), (r) => r.status === 7 && r.stdout.includes("中文")]);
  cases.push([exe + " unknown command exit 1", () => run(exe, psArgs(`nonexist-命令-xyz`)), (r) => r.status === 1 && r.stderr.includes("nonexist-命令-xyz")]);
  cases.push([exe + " native tool", () => run(exe, psArgs(`cmd /c echo 原生中文`)), (r) => r.status === 0 && r.stdout.includes("原生中文")]);
}
cases.push(["cmd stdout+type", () => run("cmd.exe", buildCmdWrapperArgs(`type "${file}" & echo 直接输出中文`)), (r) => r.status === 0 && r.stdout.includes("中文测试：你好，世界！— probe ✓") && r.stdout.includes("直接输出中文")]);
cases.push(["cmd builtin error", () => run("cmd.exe", buildCmdWrapperArgs(`dir 不存在_中文`)), (r) => (r.stderr + r.stdout).includes("不存在_中文") === false ? !/\uFFFD/.test(r.stderr) && r.stderr.length > 0 : true]);
cases.push(["cmd exit code", () => run("cmd.exe", buildCmdWrapperArgs(`echo 中文 & exit /b 9`)), (r) => r.status === 9 && r.stdout.includes("中文")]);

let failed = 0;
for (const [name, exec, ok] of cases) {
  const r = exec();
  const pass = ok(r);
  console.log((pass ? "PASS " : "FAIL ") + name);
  if (!pass) { failed++; console.log("  status=" + r.status + "\n  stdout=" + JSON.stringify(r.stdout) + "\n  stderr=" + JSON.stringify(r.stderr)); }
}
console.log(failed ? `${failed} FAILED` : `ALL ${cases.length} PASSED`);
process.exit(failed ? 1 : 0);
