/**
 * Status bar item mirroring BridgeState:
 * idle / starting / running (prominent) / error (red background).
 */
import * as vscode from "vscode";
import { BridgeManager } from "./bridge-manager";
import { t } from "./nls";
import { TunnelProvider } from "./types";

function providerTag(p: TunnelProvider): string {
  return t(`status.tag.${p}`);
}

export function installStatusBar(bm: BridgeManager): vscode.Disposable {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = "portal.showPanel";
  item.tooltip = t("status.tooltip.default");
  item.show();

  // Re-render on every state change (subscribed below).
  const render = () => {
    const s = bm.getState();
    switch (s.kind) {
      case "idle":
        item.text = t("status.idle");
        item.backgroundColor = undefined;
        item.tooltip = t("status.tooltip.idle");
        break;
      case "starting":
        item.text = t("status.starting");
        item.backgroundColor = undefined;
        item.tooltip = t("status.tooltip.starting", s.provider);
        break;
      case "running":
        item.text = t("status.running", providerTag(s.provider), String(s.localPort));
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.prominentBackground");
        item.tooltip = t("status.tooltip.running", s.publicUrl, String(s.localPort));
        break;
      case "error":
        item.text = t("status.error");
        item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
        item.tooltip = t("status.tooltip.error", s.message);
        break;
    }
  };

  const sub = bm.onState(render);
  render();
  return vscode.Disposable.from(item, sub);
}
