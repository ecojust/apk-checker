export type DeviceMode = "phone" | "tv";
export interface InstalledApp {
  avd: string;
  installedAt: string;
}
export interface LibraryApp {
  id: string;
  name: string;
  packageName: string;
  versionName: string;
  versionCode: string;
  size: number;
  importedAt: string;
  fileName: string;
  minSdk?: string;
  launchableActivity?: string;
  tvActivity?: string;
  installed: Partial<Record<DeviceMode, InstalledApp>>;
}
export interface Settings {
  sdkPath: string;
  scrcpyPath: string;
  phoneAvd: string;
  tvAvd: string;
  defaultMode: DeviceMode;
}
export interface RuntimeStatus {
  sdkFound: boolean;
  adbFound: boolean;
  emulatorFound: boolean;
  aaptFound: boolean;
  scrcpyFound: boolean;
  avds: string[];
  devices: { serial: string; avd: string; state: string }[];
  issues: string[];
}
export interface AppState {
  apps: LibraryApp[];
  settings: Settings;
  runtime: RuntimeStatus;
  managed?: ManagedRuntimeStatus;
}
export interface ManagedRuntimeStatus {
  supported: boolean;
  coreReady: boolean;
  phoneReady: boolean;
  tvReady: boolean;
  licenseAccepted: boolean;
  preparing?: DeviceMode;
  downloadBytes: { phone: number; tv: number };
  error?: string;
}
export interface OperationProgress {
  appId?: string;
  mode?: DeviceMode;
  message: string;
  kind?: "info" | "error";
  completedBytes?: number;
  totalBytes?: number;
}
export interface ActionResult {
  ok: boolean;
  error?: string;
}
export interface ImportResult extends ActionResult {
  imported: number;
  errors: string[];
  warnings?: string[];
}
export interface ApkCheckerApi {
  getState(): Promise<AppState>;
  importApks(): Promise<ImportResult>;
  installApp(id: string, mode: DeviceMode): Promise<ActionResult>;
  launchApp(id: string, mode: DeviceMode): Promise<ActionResult>;
  sendText(mode: DeviceMode, text: string): Promise<ActionResult>;
  uninstallApp(id: string, mode: DeviceMode): Promise<ActionResult>;
  removeApp(id: string): Promise<ActionResult>;
  saveSettings(settings: Settings): Promise<ActionResult>;
  refreshRuntime(): Promise<RuntimeStatus>;
  prepareEnvironment(mode: DeviceMode, acceptLicense?: boolean): Promise<ActionResult>;
  cancelPreparation(): Promise<ActionResult>;
  getRuntimeLicense(): Promise<string>;
  onProgress(callback: (progress: OperationProgress) => void): () => void;
  onStateChanged(callback: () => void): () => void;
}
declare global {
  interface Window {
    apkChecker?: ApkCheckerApi;
  }
}
