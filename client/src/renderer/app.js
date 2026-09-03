/* Portal Client renderer — plain JS, Fluent UI. */
"use strict";

const portalApi = window.api;
const el = (id) => document.getElementById(id);
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

let LANG = "en";
let STR = {};
let t = (k, ...a) => String(STR[k] ?? k).replace(/\{(\d+)\}/g, (_, i) => a[i] ?? "");

const state = { config: null, diag: null, prompts: { templates: [], url: undefined }, stats: null, grabbing: false };
let currentPage = "overview";
let editingPromptIndex = -1;
let toastSeq = 0;

/* ---------------- boot ---------------- */
async function boot() {
  try {
    const [info, strings] = await Promise.all([portalApi.getAppInfo(), portalApi.getStrings()]);
    LANG = strings.lang;
    STR = strings.strings;
    t = (k, ...a) => String(STR[k] ?? k).replace(/\{(\d+)\}/g, (_, i) => a[i] ?? "");
    el("navVersion").textContent = "v" + info.version;
  } catch (e) {
    console.error("boot:", e);
  }
  applyI18n();
  bindNav();
  bindOverview();
  bindBrowser();
  bindSettings();
  bindLog();
  bindTerminal();
  bindToasts();

  await refreshAll();
  subscribeEvents();
}

function applyI18n() {
  $$("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (STR[key]) node.textContent = STR[key];
  });
  el("inpLanguage").value = state.config?.language || "system";
}

/* ---------------- navigation ---------------- */
function bindNav() {
  $$(".nav-item[data-page]").forEach((item) => {
    item.addEventListener("click", () => switchPage(item.getAttribute("data-page")));
  });
  el("navBrowserToggle").addEventListener("click", () => toggleBrowserPanel());
}

function switchPage(page) {
  currentPage = page;
  $$(".nav-item[data-page]").forEach((n) => n.classList.toggle("active", n.getAttribute("data-page") === page));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + page));
  if (page === "log") renderLog();
  if (page === "terminal") scrollTerminal();
}

/* ---------------- toasts ---------------- */
function bindToasts() {
  // nothing to pre-bind; toast() is called on demand
}

function toast(message, kind = "info") {
  const box = el("toasts");
  const node = document.createElement("div");
  node.className = "toast " + kind;
  node.innerHTML = `<span class="t-ico"></span><span></span>`;
  node.lastElementChild.textContent = message;
  box.appendChild(node);
  const id = ++toastSeq;
  setTimeout(() => {
    node.classList.add("leaving");
    setTimeout(() => node.remove(), 220);
  }, 3600);
}

/* ---------------- data refresh ---------------- */
async function refreshAll() {
  state.config = await portalApi.getConfig();
  state.diag = await portalApi.getDiag();
  state.stats = await portalApi.getStats();
  state.prompts = await portalApi.getPrompts();
  applyI18n();
  renderState(await portalApi.getState());
  renderConfig();
  renderStats(state.stats);
  renderActivities(await portalApi.getActivities());
  renderDiag(state.diag);
  renderPrompts();
  renderTools(await portalApi.getTools());
  renderLog();
  renderBrowserWindows();
}

function subscribeEvents() {
  portalApi.on("portal:state", (p) => {
    renderState(p.state);
    portalApi.getPrompts().then((pr) => {
      state.prompts = pr;
      renderPrompts();
    });
  });
  portalApi.on("portal:config", (p) => {
    state.config = p.config;
    applyI18n();
    renderConfig();
  });
  portalApi.on("portal:diag", (p) => renderDiag(p.diag));
  portalApi.on("portal:activity", (p) => renderActivities(p.items));
  portalApi.on("portal:stats", (p) => renderStats(p.stats));
  portalApi.on("portal:prompts", (p) => {
    state.prompts = p;
    renderPrompts();
  });
  portalApi.on("portal:log", (p) => {
    if (p.cleared) {
      el("logView").innerHTML = "";
      return;
    }
    if (p.entry) appendLogLine(p.entry);
  });
  portalApi.on("agent:line", (p) => appendTermLine(p.line));
  portalApi.on("browser:attachedChanged", () => renderBrowserWindows());
  portalApi.on("portal:toast", (p) => toast(p.message, p.kind));
  portalApi.on("browser:embedState", (p) => {
    if (p.info && p.info.url) el("bUrl").value = p.info.url;
    el("bBackBtn").disabled = !(p.info && p.info.canGoBack);
    el("bFwdBtn").disabled = !(p.info && p.info.canGoForward);
  });
}

/* ---------------- overview ---------------- */
function bindOverview() {
  el("ovStartBtn").addEventListener("click", () => portalApi.start());
  el("ovStopBtn").addEventListener("click", () => portalApi.stop());
  el("ovCopyBtn").addEventListener("click", () => portalApi.copyUrl());
  el("ovCopyPromptBtn").addEventListener("click", copyQuickPrompt);
  el("ovChooseBtn").addEventListener("click", async () => {
    state.config = await portalApi.chooseWorkspace();
    renderConfig();
  });
  el("ovAdviceCopy").addEventListener("click", () => {
    const sol = el("ovAdviceSol").textContent;
    if (sol) portalApi.copyText(sol);
  });
  el("ovAdviceLink").addEventListener("click", (e) => {
    e.preventDefault();
    const url = el("ovAdviceLink").getAttribute("href");
    if (url && url !== "#") portalApi.openExternal(url);
  });
}

let lastStateKind = "idle";
let bridgeRunning = false;
let lastPublicUrl = undefined;

function isBridgeRunning() {
  return bridgeRunning;
}

function renderState(s) {
  lastStateKind = s.kind;
  bridgeRunning = s.kind === "running" || s.kind === "starting";
  if (s.kind === "running") lastPublicUrl = s.publicUrl;

  const led = el("ovLed");
  const tbLed = el("tbLed");
  const badge = el("ovBadge");
  const stateText = el("ovStateText");
  const sub = el("ovStateSub");
  const urlInput = el("ovUrl");
  const advice = el("ovAdvice");
  el("ovUrl").placeholder = t("overview.placeholderUrl");

  const setLed = (cls) => {
    led.className = "led big " + cls;
    tbLed.className = "led " + cls;
  };

  switch (s.kind) {
    case "idle":
      setLed("");
      badge.className = "badge idle";
      badge.textContent = t("state.idle");
      stateText.textContent = t("state.idle");
      sub.textContent = t("overview.endpointDown");
      urlInput.value = "";
      el("tbStateText").textContent = t("state.idle");
      break;
    case "starting":
      setLed("warn");
      badge.className = "badge starting";
      badge.textContent = t("state.starting");
      stateText.textContent = t("state.starting");
      sub.textContent = t("log.starting", s.provider);
      el("tbStateText").textContent = t("state.starting");
      break;
    case "running":
      setLed("ok");
      badge.className = "badge running";
      badge.textContent = t("state.running");
      stateText.textContent = t("state.running");
      sub.textContent = t("overview.endpointOpen", s.publicUrl);
      urlInput.value = s.publicUrl;
      el("tbStateText").textContent = t("state.running");
      break;
    case "error":
      setLed("err");
      badge.className = "badge error";
      badge.textContent = t("state.error");
      stateText.textContent = t("state.error");
      sub.textContent = t("overview.errorPrefix", s.message);
      el("tbStateText").textContent = t("state.error");
      break;
  }

  const running = s.kind === "running" || s.kind === "starting";
  el("ovStartBtn").disabled = running;
  el("ovStopBtn").disabled = !running;
  el("ovCopyBtn").disabled = s.kind !== "running";

  // advice
  if (s.kind === "error" && s.advice) {
    advice.classList.add("show");
    el("ovAdviceCode").textContent = s.advice.code || "";
    el("ovAdviceCode").style.display = s.advice.code ? "" : "none";
    el("ovAdviceTitle").textContent = s.advice.title || "";
    el("ovAdviceSol").textContent = s.advice.solution || "";
    const link = s.advice.link;
    el("ovAdviceLink").style.display = link ? "" : "none";
    el("ovAdviceLink").setAttribute("href", link || "#");
  } else {
    advice.classList.remove("show");
  }
}

function renderStats(st) {
  if (!st) return;
  state.stats = st;
  el("stCalls").textContent = st.toolCalls;
  el("stFail").textContent = st.failures;
  el("stActive").textContent = st.activeRequests;
  el("stProto").textContent = st.protocol;
  const avg = st.toolCalls > 0 ? Math.round(st.totalResponseMs / st.toolCalls) : 0;
  el("stAvg").textContent = avg + " ms";
  const done = st.toolCalls;
  const ok = done - st.failures;
  el("stOk").textContent = done > 0 ? Math.round((ok / done) * 100) + "%" : "—";
  const conn = el("ovConn");
  conn.classList.toggle("live", st.connected);
  if (st.connected) conn.textContent = t("overview.connected");
  else conn.textContent = bridgeRunning ? t("overview.waiting") : t("overview.stopped");
}

function renderActivities(items) {
  const feed = el("ovFeed");
  if (!items || !items.length) {
    feed.innerHTML = `<div class="empty"><div>${t("overview.empty")}</div><div class="empty-sub">${t("overview.emptyHint")}</div></div>`;
    return;
  }
  feed.innerHTML = items
    .slice()
    .reverse()
    .map(
      (a) => `<div class="item ${a.ok ? "" : "err"}">
        <span class="ico">${a.ok ? iconCheck() : iconCross()}</span>
        <span class="body"><div class="t"></div><div class="d"></div></span>
        <span class="dur">${fmtDur(a.durationMs)}</span>
      </div>`,
    )
    .join("");
  const rows = $$(".item", feed);
  const rev = items.slice().reverse();
  rows.forEach((row, i) => {
    $(".t", row).textContent = rev[i].title;
    $(".d", row).textContent = rev[i].detail + " · " + timeAgo(rev[i].ts);
  });
}

async function copyQuickPrompt() {
  const url = state.prompts.url || lastPublicUrl;
  if (!url) {
    toast(t("msg.startFirst"), "warn");
    return;
  }
  const text =
    LANG === "zh"
      ? `连接 MCP 端点 ${url}\n然后执行我需要的操作。`
      : `Connect to the MCP endpoint ${url}\nThen do what I need.`;
  await portalApi.copyText(text);
  toast(t("msg.copied"), "success");
}

/* ---------------- browser panel (right dock) ---------------- */
let measureTimer = null;
let browserPanelOpen = false;
let browserPanelWidth = 560;
try {
  const saved = parseInt(localStorage.getItem("portal.browserPanelWidth"), 10);
  if (Number.isFinite(saved) && saved > 0) browserPanelWidth = saved;
} catch {
  /* ignore */
}

function bindBrowser() {
  el("bGoBtn").addEventListener("click", () => portalApi.browserOpenEmbedded(el("bUrl").value.trim() || "https://www.bing.com"));
  el("bUrl").addEventListener("keydown", (e) => {
    if (e.key === "Enter") portalApi.browserOpenEmbedded(el("bUrl").value.trim() || "https://www.bing.com");
  });
  el("bBackBtn").addEventListener("click", () => portalApi.browserControl("back"));
  el("bFwdBtn").addEventListener("click", () => portalApi.browserControl("forward"));
  el("bReloadBtn").addEventListener("click", () => portalApi.browserControl("reload"));
  el("bHomeBtn").addEventListener("click", () => portalApi.browserOpenEmbedded("https://www.bing.com"));
  el("bCloseBtn").addEventListener("click", () => closeBrowserPanel());
  el("bRefreshBtn").addEventListener("click", renderBrowserWindows);
  el("bGrabBtn").addEventListener("click", () => {
    openBrowserPanel();
    portalApi.browserGrab();
    state.grabbing = true;
    el("grabHint").hidden = false;
  });
  el("bGrabCancelBtn").addEventListener("click", () => {
    portalApi.browserCancelGrab();
    state.grabbing = false;
    el("grabHint").hidden = true;
  });

  bindSplitter();
  window.addEventListener("resize", () => {
    if (browserPanelOpen) {
      browserPanelWidth = clampPanelWidth(browserPanelWidth);
      el("browserPanel").style.width = browserPanelWidth + "px";
    }
    scheduleEmbedMeasure();
  });
}

function openBrowserPanel() {
  browserPanelOpen = true;
  el("navBrowserToggle").classList.add("active");
  el("browserPanel").hidden = false;
  el("splitter").hidden = false;
  el("browserPanel").style.width = clampPanelWidth(browserPanelWidth) + "px";
  scheduleEmbedMeasure();
  renderBrowserWindows();
}

function closeBrowserPanel() {
  browserPanelOpen = false;
  el("navBrowserToggle").classList.remove("active");
  el("browserPanel").hidden = true;
  el("splitter").hidden = true;
  el("browserPanel").style.width = "";
  hideEmbeds();
}

function toggleBrowserPanel() {
  if (browserPanelOpen) closeBrowserPanel();
  else openBrowserPanel();
}

function clampPanelWidth(w) {
  const navW = el("nav").getBoundingClientRect().width || 232;
  const maxW = Math.max(320, window.innerWidth - navW - 240);
  return Math.max(320, Math.min(maxW, w));
}

function bindSplitter() {
  const sp = el("splitter");
  sp.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sp.classList.add("dragging");
    try {
      sp.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  sp.addEventListener("pointermove", (e) => {
    if (!sp.classList.contains("dragging")) return;
    const w = clampPanelWidth(window.innerWidth - e.clientX);
    browserPanelWidth = w;
    el("browserPanel").style.width = w + "px";
    scheduleEmbedMeasure();
  });
  sp.addEventListener("pointerup", () => {
    if (!sp.classList.contains("dragging")) return;
    sp.classList.remove("dragging");
    try {
      localStorage.setItem("portal.browserPanelWidth", String(browserPanelWidth));
    } catch {
      /* ignore */
    }
    scheduleEmbedMeasure();
  });
  sp.addEventListener("pointercancel", () => sp.classList.remove("dragging"));
}

async function renderBrowserWindows() {
  const list = await portalApi.browserList();
  const attached = await portalApi.browserAttached();
  const attachedSet = new Set(attached.map((a) => a.hwnd));
  const box = el("bpWinsScroll");
  const wrap = el("bpWins");
  if (state.grabbing) el("grabHint").hidden = false;
  const badge = el("navBrowserBadge");
  badge.hidden = attached.length === 0;
  badge.textContent = String(attached.length);
  if (!list.length) {
    wrap.hidden = true;
    box.innerHTML = "";
    return;
  }
  wrap.hidden = false;
  box.innerHTML = list
    .map(
      (w) => `<div class="win-item ${attachedSet.has(w.hwnd) ? "docked" : ""}">
        <span class="w-ico">${iconBrowser(w.processName)}</span>
        <span class="w-info"><div class="w-title"></div><div class="w-sub"></div></span>
        ${attachedSet.has(w.hwnd) ? `<span class="tag on">${t("browser.attached")}</span>` : ""}
        <button class="btn small ${attachedSet.has(w.hwnd) ? "danger" : "primary"}" data-hwnd="${w.hwnd}" data-act="${attachedSet.has(w.hwnd) ? "detach" : "attach"}">${attachedSet.has(w.hwnd) ? t("browser.detach") : t("browser.attach")}</button>
      </div>`,
    )
    .join("");
  const rows = $$(".win-item", box);
  rows.forEach((row, i) => {
    $(".w-title", row).textContent = list[i].title;
    $(".w-sub", row).textContent = list[i].processName + " · PID " + list[i].pid;
  });
  $$("button[data-hwnd]", box).forEach((btn) => {
    btn.addEventListener("click", () => {
      const hwnd = Number(btn.getAttribute("data-hwnd"));
      const act = btn.getAttribute("data-act");
      if (act === "attach") {
        portalApi.browserAttach(hwnd);
        state.grabbing = false;
        el("grabHint").hidden = true;
      } else {
        portalApi.browserDetach(hwnd);
      }
      setTimeout(renderBrowserWindows, 300);
    });
  });
}

function scheduleEmbedMeasure() {
  if (!browserPanelOpen) return;
  clearTimeout(measureTimer);
  measureTimer = setTimeout(measureEmbed, 60);
}

function measureEmbed() {
  if (!browserPanelOpen) {
    hideEmbeds();
    return;
  }
  const host = el("bpView");
  const rect = host.getBoundingClientRect();
  if (rect.width < 10 || rect.height < 10) {
    hideEmbeds();
    return;
  }
  portalApi.browserEmbedBounds({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
}

function hideEmbeds() {
  clearTimeout(measureTimer);
  portalApi.browserEmbedBounds(null);
}

/* ---------------- settings ---------------- */
const PROVIDERS = [
  { id: "ngrok-reserved", nameKey: "provider.ngrok-reserved.name", descKey: "provider.ngrok-reserved.desc" },
  { id: "cloudflare-quick", nameKey: "provider.cloudflare-quick.name", descKey: "provider.cloudflare-quick.desc" },
  { id: "cloudflare-named", nameKey: "provider.cloudflare-named.name", descKey: "provider.cloudflare-named.desc" },
  { id: "custom", nameKey: "provider.custom.name", descKey: "provider.custom.desc" },
];

function bindSettings() {
  const list = el("providerList");
  list.innerHTML = PROVIDERS.map(
    (p) => `<div class="prov" data-provider="${p.id}">
      <span class="p-radio"></span>
      <span><h3 data-i18n="${p.nameKey}"></h3><p data-i18n="${p.descKey}"></p></span>
    </div>`,
  ).join("");
  $$(".prov", list).forEach((node) => {
    node.addEventListener("click", () => {
      const id = node.getAttribute("data-provider");
      if (isBridgeRunning()) {
        toast(t("msg.providerLocked"), "warn");
        return;
      }
      portalApi.setConfig("tunnelProvider", id).then((cfg) => {
        state.config = cfg;
        renderConfig();
        portalApi.refreshDiag();
      });
    });
  });

  // provider-specific fields
  bindText("inpNgrokDomain", "ngrokDomain");
  el("inpNgrokPooling").addEventListener("change", () => portalApi.setConfig("ngrokPoolingEnabled", el("inpNgrokPooling").checked));
  bindText("inpCfDomain", "cloudflareDomain");
  el("btnCfSave").addEventListener("click", async () => {
    state.config = await portalApi.saveCloudflareToken(el("inpCfToken").value);
    el("inpCfToken").value = "";
    renderConfig();
  });
  el("btnCfClear").addEventListener("click", async () => {
    state.config = await portalApi.clearCloudflareToken();
    renderConfig();
  });
  bindText("inpCustomCommand", "customTunnelCommand");
  bindText("inpCustomUrl", "customTunnelUrl");
  bindText("inpCustomUrlPattern", "customTunnelUrlPattern");
  bindText("inpCustomReadyPattern", "customTunnelReadyPattern");
  bindText("inpRouteToken", "routeToken");
  el("btnRegenToken").addEventListener("click", async () => {
    state.config = await portalApi.resetRouteToken();
    renderConfig();
  });
  el("inpLocalPort").addEventListener("change", () => portalApi.setConfig("localPort", Number(el("inpLocalPort").value) || 0));
  el("inpMaxTransfer").addEventListener("change", () => portalApi.setConfig("maxTransferBytes", Number(el("inpMaxTransfer").value) || 67108864));
  el("inpAutoStart").addEventListener("change", () => portalApi.setConfig("startOnActivation", el("inpAutoStart").checked));
  el("inpShowTerm").addEventListener("change", () => portalApi.setConfig("showCommandsInTerminal", el("inpShowTerm").checked));
  el("inpLanguage").addEventListener("change", async () => {
    await portalApi.setConfig("language", el("inpLanguage").value);
    location.reload();
  });
  el("btnRecheck").addEventListener("click", async () => renderDiag(await portalApi.refreshDiag()));
  el("btnOpenLogFolder").addEventListener("click", () => portalApi.openLogFolder());
  el("btnSaveInstructions").addEventListener("click", async () => {
    await portalApi.setConfig("agentInstructions", el("inpAgentInstructions").value);
    toast(t("msg.instructionsSaved"), "success");
  });

  // prompts
  el("promptAddBtn").addEventListener("click", savePrompt);
  el("promptUpdateBtn").addEventListener("click", savePrompt);
  el("promptCancelBtn").addEventListener("click", cancelPromptEdit);
}

function bindText(id, key) {
  const node = el(id);
  const commit = () => {
    portalApi.setConfig(key, node.value);
  };
  node.addEventListener("change", commit);
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") node.blur();
  });
}

function renderConfig() {
  const cfg = state.config;
  if (!cfg) return;
  // provider
  $$(".prov").forEach((node) => {
    node.classList.toggle("active", node.getAttribute("data-provider") === cfg.tunnelProvider);
  });
  el("card-ngrok").hidden = cfg.tunnelProvider !== "ngrok-reserved";
  el("card-cf").hidden = cfg.tunnelProvider !== "cloudflare-named";
  el("card-custom").hidden = cfg.tunnelProvider !== "custom";

  setVal("inpNgrokDomain", cfg.ngrokDomain);
  setVal("inpNgrokPooling", cfg.ngrokPoolingEnabled);
  setVal("inpCfDomain", cfg.cloudflareDomain);
  el("cfTokenState").textContent = cfg.cloudflareTunnelTokenSet ? t("settings.cfTokenStored") : t("settings.cfTokenMissing");
  setVal("inpCustomCommand", cfg.customTunnelCommand);
  setVal("inpCustomUrl", cfg.customTunnelUrl);
  setVal("inpCustomUrlPattern", cfg.customTunnelUrlPattern);
  setVal("inpCustomReadyPattern", cfg.customTunnelReadyPattern);
  setVal("inpRouteToken", cfg.routeToken);
  setVal("inpLocalPort", cfg.localPort);
  setVal("inpMaxTransfer", cfg.maxTransferBytes);
  setVal("inpAutoStart", cfg.startOnActivation);
  setVal("inpShowTerm", cfg.showCommandsInTerminal);
  setVal("inpAgentInstructions", cfg.agentInstructions);
  setVal("inpLanguage", cfg.language);

  // workspace
  el("ovWorkspace").textContent = cfg.workspaceRoot || "—";
}

function setVal(id, value) {
  const node = el(id);
  if (!node) return;
  if (document.activeElement === node) return; // don't clobber typing
  if (node.type === "checkbox") node.checked = !!value;
  else node.value = value == null ? "" : value;
}

function renderDiag(diag) {
  if (!diag) return;
  const cf = el("diagCloudflared");
  const ng = el("diagNgrok");
  cf.innerHTML = `<span class="d-name">cloudflared</span>
    <span class="d-status ${diag.cloudflaredInstalled ? "ok" : "warn"}">${diag.cloudflaredInstalled ? (diag.cloudflaredVersion || t("settings.detected")) : t("settings.notDetected")}</span>
    <button class="btn small" data-install="cf">${diag.cloudflaredInstalled ? t("settings.reinstall") : t("settings.install")}</button>`;
  ng.innerHTML = `<span class="d-name">ngrok</span>
    <span class="d-status ${diag.ngrokInstalled ? "ok" : "warn"}">${diag.ngrokInstalled ? (diag.ngrokVersion || t("settings.detected")) : t("settings.notDetected")}</span>
    ${diag.ngrokInstalled && !diag.ngrokConfigValid ? `<span class="d-status warn">${t("settings.authtokenMissing")}</span>` : ""}
    <button class="btn small" data-install="ng">${diag.ngrokInstalled ? t("settings.reinstall") : t("settings.install")}</button>`;
  cf.querySelector("button").addEventListener("click", async () => renderDiag(await portalApi.installCloudflared()));
  ng.querySelector("button").addEventListener("click", async () => renderDiag(await portalApi.installNgrok()));
}

function renderPrompts() {
  const list = el("promptList");
  const templates = state.prompts.templates || [];
  if (!templates.length) {
    list.innerHTML = `<div class="empty"><div>${t("prompt.empty")}</div></div>`;
  } else {
    list.innerHTML = templates
      .map(
        (p, i) => `<div class="tpl">
          <div class="tpl-head">
            <span class="tpl-name"></span>
            ${hasUrl(p.text) ? `<span class="tpl-urltag ${state.prompts.url ? "" : "nourl"}">${state.prompts.url ? t("prompt.copyTip") : t("prompt.needsUrl")}</span>` : `<span class="tag">${t("prompt.staticTip")}</span>`}
            <button class="btn small" data-copy="${i}">${t("prompt.copy")}</button>
            <button class="btn small" data-edit="${i}">${t("prompt.edit")}</button>
            <button class="btn small danger" data-del="${i}">${t("prompt.delete")}</button>
          </div>
          <div class="tpl-preview"></div>
        </div>`,
      )
      .join("");
    $$(".tpl", list).forEach((node, i) => {
      $(".tpl-name", node).textContent = templates[i].name;
      $(".tpl-preview", node).textContent = preview(templates[i].text);
    });
    $$("button[data-copy]", list).forEach((b) =>
      b.addEventListener("click", () => {
        const text = renderUrl(templates[Number(b.getAttribute("data-copy"))].text);
        if (hasUrl(text) && !state.prompts.url) {
          toast(t("msg.startFirst"), "warn");
          return;
        }
        portalApi.copyText(text);
        toast(t("msg.copied"), "success");
      }),
    );
    $$("button[data-edit]", list).forEach((b) =>
      b.addEventListener("click", () => startEditPrompt(Number(b.getAttribute("data-edit")))),
    );
    $$("button[data-del]", list).forEach((b) =>
      b.addEventListener("click", async () => {
        state.prompts = await portalApi.deletePrompt(Number(b.getAttribute("data-del")));
        renderPrompts();
      }),
    );
  }
}

function hasUrl(text) {
  return /\{url\}/i.test(text);
}
function renderUrl(text) {
  return state.prompts.url ? text.replace(/\{url\}/gi, state.prompts.url) : text;
}
function preview(text) {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 120 ? one.slice(0, 119) + "…" : one;
}

function startEditPrompt(index) {
  const p = state.prompts.templates[index];
  editingPromptIndex = index;
  el("promptName").value = p.name;
  el("promptText").value = p.text;
  el("promptAddBtn").hidden = true;
  el("promptUpdateBtn").hidden = false;
  el("promptCancelBtn").hidden = false;
}

function cancelPromptEdit() {
  editingPromptIndex = -1;
  el("promptName").value = "";
  el("promptText").value = "";
  el("promptAddBtn").hidden = false;
  el("promptUpdateBtn").hidden = true;
  el("promptCancelBtn").hidden = true;
}

async function savePrompt() {
  const name = el("promptName").value.trim();
  const text = el("promptText").value.trim();
  if (!text) return;
  const p = { name: name || text.replace(/\s+/g, " ").slice(0, 24), text };
  if (editingPromptIndex >= 0) {
    state.prompts = await portalApi.updatePrompt(editingPromptIndex, p);
  } else {
    state.prompts = await portalApi.addPrompt(p);
  }
  cancelPromptEdit();
  renderPrompts();
}

function renderTools(tools) {
  const list = el("toolsList");
  list.innerHTML = (tools || [])
    .map(
      (tool) => `<li><span class="tname">${escapeHtml(tool.name)}</span><div class="tdesc">${escapeHtml(tool.description)}</div></li>`,
    )
    .join("");
}

/* ---------------- log ---------------- */
function bindLog() {
  el("logClearBtn").addEventListener("click", () => portalApi.clearLogs());
  el("logFolderBtn").addEventListener("click", () => portalApi.openLogFolder());
}

function renderLog() {
  portalApi.getLogs().then((logs) => {
    const view = el("logView");
    view.innerHTML = "";
    (logs || []).forEach(appendLogLine);
    scrollBottom(view);
  });
}

function appendLogLine(entry) {
  const view = el("logView");
  const line = document.createElement("div");
  line.className = "lvl-" + entry.level;
  const ts = new Date(entry.ts).toLocaleTimeString();
  line.textContent = `[${ts}] ${entry.level.toUpperCase().padEnd(5)} ${entry.message}`;
  view.appendChild(line);
  while (view.children.length > 600) view.removeChild(view.firstChild);
  if (currentPage === "log") scrollBottom(view);
}

/* ---------------- terminal ---------------- */
function bindTerminal() {
  el("termClearBtn").addEventListener("click", () => {
    el("termView").innerHTML = "";
    appendTermLine({ kind: "info", text: t("agent.ready") + "\n" });
  });
  el("termFollow").addEventListener("change", scrollTerminal);
}

function appendTermLine(line) {
  const view = el("termView");
  const div = document.createElement("div");
  div.className = "tk-" + (line.kind || "out");
  div.textContent = line.text || "";
  view.appendChild(div);
  while (view.children.length > 2000) view.removeChild(view.firstChild);
  scrollTerminal();
}

function scrollTerminal() {
  if (el("termFollow") && el("termFollow").checked) scrollBottom(el("termView"));
}

function scrollBottom(node) {
  requestAnimationFrame(() => {
    node.scrollTop = node.scrollHeight;
  });
}

/* ---------------- utils ---------------- */
function fmtDur(ms) {
  if (ms == null) return "";
  if (ms < 1000) return ms + " ms";
  return (ms / 1000).toFixed(1) + " s";
}
function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 5000) return "now";
  if (d < 60000) return Math.round(d / 1000) + "s ago";
  if (d < 3600000) return Math.round(d / 60000) + "m ago";
  return new Date(ts).toLocaleTimeString();
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function iconCheck() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 5 5 9-10" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function iconCross() {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18" stroke-linecap="round"/></svg>`;
}
function iconBrowser(proc) {
  const letter = (proc || "b").replace(/\.exe$/, "").charAt(0).toUpperCase();
  return `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.4"/><text x="12" y="16" text-anchor="middle" font-size="11" fill="currentColor" font-family="Segoe UI">${letter}</text></svg>`;
}

boot();
