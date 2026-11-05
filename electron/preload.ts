import { contextBridge, ipcRenderer } from "electron";
import type { ApkCheckerApi, OperationProgress } from "../src/shared/types";

const api: ApkCheckerApi = {
  getState: () => ipcRenderer.invoke("apk:state"),
  importApks: () => ipcRenderer.invoke("apk:import"),
  installApp: (id, mode) => ipcRenderer.invoke("apk:install", id, mode),
  launchApp: (id, mode) => ipcRenderer.invoke("apk:launch", id, mode),
  uninstallApp: (id, mode) => ipcRenderer.invoke("apk:uninstall", id, mode),
  removeApp: (id) => ipcRenderer.invoke("apk:remove", id),
  saveSettings: (settings) => ipcRenderer.invoke("apk:settings", settings),
  choosePath: (kind) => ipcRenderer.invoke("apk:choose-path", kind),
  refreshRuntime: () => ipcRenderer.invoke("apk:runtime"),
  onProgress(callback) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      value: OperationProgress,
    ) => callback(value);
    ipcRenderer.on("apk:progress", handler);
    return () => {
      ipcRenderer.removeListener("apk:progress", handler);
    };
  },
  onStateChanged(callback) {
    const handler = () => callback();
    ipcRenderer.on("apk:changed", handler);
    return () => {
      ipcRenderer.removeListener("apk:changed", handler);
    };
  },
};
contextBridge.exposeInMainWorld("apkChecker", api);
