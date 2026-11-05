import { app, BrowserWindow, dialog, ipcMain, Menu, net } from "electron";
import path from "node:path";
import { AppLibrary } from "./library";
import { AndroidRuntime } from "./android";
import { ManagedRuntime } from "./managed-runtime";
import type {
  ActionResult,
  DeviceMode,
  ImportResult,
  OperationProgress,
  RuntimeStatus,
  Settings,
} from "../src/shared/types";

let mainWindow: BrowserWindow | null = null;
let library: AppLibrary;
let managed: ManagedRuntime;
let runtime: AndroidRuntime;
let busy = false;
let preparationCancellation = 0;
let cachedRuntime: { at: number; value: RuntimeStatus } | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function progress(
  message: string,
  appId?: string,
  mode?: DeviceMode,
  kind: "info" | "error" = "info",
  completedBytes?: number,
  totalBytes?: number,
) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("apk:progress", {
      message,
      appId,
      mode,
      kind,
      completedBytes,
      totalBytes,
    } satisfies OperationProgress);
  }
}

function changed() {
  cachedRuntime = undefined;
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send("apk:changed");
}

async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (busy) throw new Error("正在处理另一个操作，请稍后重试。");
  busy = true;
  try {
    return await operation();
  } finally {
    busy = false;
  }
}

async function action(operation: () => Promise<void>): Promise<ActionResult> {
  try {
    await exclusive(operation);
    changed();
    return { ok: true };
  } catch (error) {
    changed();
    return { ok: false, error: errorMessage(error) };
  }
}

function validMode(value: unknown): DeviceMode {
  if (value !== "phone" && value !== "tv") throw new Error("无效的设备模式。");
  return value;
}

function validId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new Error("无效的应用标识。");
  return value;
}

function validSettings(value: unknown): Settings {
  if (!value || typeof value !== "object") throw new Error("设置格式无效。");
  const input = value as Record<string, unknown>;
  // Tool locations and device names are owned by the application, not renderer inputs.
  return managed.getSettings(validMode(input.defaultMode));
}

async function prepareDevice(mode: DeviceMode, appId?: string): Promise<Settings> {
  await managed.prepare(mode, (message, completed, total) =>
    progress(message, appId, mode, "info", completed, total),
  );
  const settings = managed.getSettings(library.getSettings().defaultMode);
  await library.saveSettings(settings);
  cachedRuntime = undefined;
  return settings;
}

async function runtimeStatus(force = false): Promise<RuntimeStatus> {
  if (!force && cachedRuntime && Date.now() - cachedRuntime.at < 5000)
    return cachedRuntime.value;
  const value = await runtime.getStatus(library.getSettings());
  cachedRuntime = { at: Date.now(), value };
  return value;
}

function registerIpc() {
  const handle = (channel: string, callback: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (
        !mainWindow ||
        event.sender !== mainWindow.webContents ||
        event.senderFrame !== mainWindow.webContents.mainFrame
      ) {
        throw new Error("请求来源无效。");
      }
      return callback(...args);
    });
  };

  handle("apk:state", async () => ({
    apps: library.getApps(),
    settings: library.getSettings(),
    runtime: await runtimeStatus(),
    managed: await managed.getStatus(),
  }));

  handle("apk:import", async (): Promise<ImportResult> => {
    try {
      return await exclusive(async () => {
        const selection = await dialog.showOpenDialog(mainWindow!, {
          title: "导入 Android 应用",
          buttonLabel: "导入软件库",
          filters: [{ name: "Android 安装包", extensions: ["apk"] }],
          properties: ["openFile", "multiSelections"],
        });
        if (selection.canceled || !selection.filePaths.length)
          return { ok: true, imported: 0, errors: [] };
        let imported = 0;
        const errors: string[] = [];
        const warnings: string[] = [];
        for (const filePath of selection.filePaths) {
          progress(`正在导入 ${path.basename(filePath)}…`);
          try {
            const result = await library.importApk(filePath);
            if (!result.duplicate) imported += 1;
            if (result.replaced)
              warnings.push(
                `${result.app.name} 的安装包已更新，请重新安装以更新桌面中的应用；原应用数据会保留。`,
              );
          } catch (error) {
            errors.push(`${path.basename(filePath)}：${errorMessage(error)}`);
          }
        }
        changed();
        return { ok: errors.length === 0, imported, errors, warnings };
      });
    } catch (error) {
      return {
        ok: false,
        imported: 0,
        errors: [errorMessage(error)],
        error: errorMessage(error),
      };
    }
  });

  handle("apk:install", (id: unknown, mode: unknown) =>
    action(async () => {
      const appId = validId(id);
      const deviceMode = validMode(mode);
      const item = library.getApp(appId);
      const settings = await prepareDevice(deviceMode, appId);
      const result = await runtime.install(
        item,
        library.getApkPath(appId),
        deviceMode,
        settings,
        (message) => progress(message, appId, deviceMode),
      );
      await library.markInstalled(appId, deviceMode, result.avd);
    }),
  );

  handle("apk:launch", (id: unknown, mode: unknown) =>
    action(async () => {
      const appId = validId(id);
      const deviceMode = validMode(mode);
      const settings = await prepareDevice(deviceMode, appId);
      await runtime.launch(
        library.getApp(appId),
        deviceMode,
        settings,
        (message) => progress(message, appId, deviceMode),
      );
    }),
  );

  handle("apk:uninstall", (id: unknown, mode: unknown) =>
    action(async () => {
      const appId = validId(id);
      const deviceMode = validMode(mode);
      const settings = await prepareDevice(deviceMode, appId);
      await runtime.uninstall(
        library.getApp(appId),
        deviceMode,
        settings,
        (message) => progress(message, appId, deviceMode),
      );
      await library.markUninstalled(appId, deviceMode);
    }),
  );

  handle("apk:remove", (id: unknown) =>
    action(async () => {
      const appId = validId(id);
      const item = library.getApp(appId);
      if (Object.keys(item.installed).length > 0)
        throw new Error(
          "请先卸载手机和电视模式中已安装的应用，再从软件库移除。",
        );
      await library.removeApp(appId);
    }),
  );

  handle("apk:settings", (settings: unknown) =>
    action(async () => {
      await library.saveSettings(validSettings(settings));
    }),
  );

  handle("apk:prepare", (mode: unknown, acceptLicense: unknown) => action(async () => {
    const cancellation = preparationCancellation;
    const deviceMode = validMode(mode);
    if (acceptLicense !== undefined && typeof acceptLicense !== "boolean") throw new Error("准备参数无效。");
    if (acceptLicense === true) await managed.acceptLicense();
    if (cancellation !== preparationCancellation) throw new Error("已取消模拟器准备。");
    await prepareDevice(deviceMode);
  }));
  handle("apk:cancel-prepare", (): ActionResult => {
    preparationCancellation += 1;
    managed.cancel();
    return { ok: true };
  });
  handle("apk:license", () => managed.getLicense());
  handle("apk:runtime", () => runtimeStatus(true));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1040,
    minHeight: 720,
    backgroundColor: "#f6f8fb",
    title: "APK Checker",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  mainWindow.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  if (process.env.VITE_DEV_SERVER_URL)
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  else void mainWindow.loadFile(path.join(__dirname, "../dist/index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.show();
    mainWindow?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      library = new AppLibrary(app.getPath("userData"));
      await library.init();
      managed = new ManagedRuntime(
        app.getPath("userData"),
        app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), "resources"),
        { fetch: net.fetch as typeof globalThis.fetch },
      );
      await managed.init();
      runtime = new AndroidRuntime(
        message => progress(message, undefined, undefined, "error"),
        managed.getEnvironment(),
      );
      await library.adoptManagedSettings(managed.getSettings(library.getSettings().defaultMode));
      registerIpc();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin"
            ? [{ role: "appMenu" as const }]
            : []),
          { role: "editMenu" },
          {
            label: "显示",
            submenu: [
              { role: "resetZoom" },
              { role: "zoomIn" },
              { role: "zoomOut" },
              { type: "separator" },
              { role: "togglefullscreen" },
            ],
          },
          { role: "windowMenu" },
        ]),
      );
      createWindow();
      app.on("activate", () => {
        if (!mainWindow) createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("APK Checker 启动失败", errorMessage(error));
      app.quit();
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
  let shuttingDown = false;
  let canQuit = false;
  app.on("before-quit", (event) => {
    if (canQuit) return;
    event.preventDefault();
    if (shuttingDown) return;
    shuttingDown = true;
    void Promise.allSettled([managed?.dispose(), runtime?.dispose()]).finally(() => {
      canQuit = true;
      app.quit();
    });
  });
}
