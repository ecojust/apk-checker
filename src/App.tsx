import { useCallback, useEffect, useRef, useState } from "react";
import { version as appVersion } from "../package.json";
import {
  ArrowDownToLine,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  ExternalLink,
  HardDrive,
  Import,
  LayoutGrid,
  LoaderCircle,
  Monitor,
  MoreHorizontal,
  Package,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Trash2,
  Tv,
  Upload,
  X,
} from "lucide-react";
import type {
  ActionResult,
  AppState,
  DeviceMode,
  LibraryApp,
  OperationProgress,
  Settings,
} from "./shared/types";

type Page = "desktop" | "library" | "settings";
type Notice = {
  type: "success" | "error" | "info";
  title: string;
  details?: string[];
};
type Confirmation = { type: "remove" | "uninstall"; app: LibraryApp };
type ManagedRequest = {
  action: "prepare" | "install" | "launch" | "uninstall";
  mode: DeviceMode;
  app?: LibraryApp;
};

const initialState: AppState = {
  apps: [],
  settings: {
    sdkPath: "",
    scrcpyPath: "",
    phoneAvd: "",
    tvAvd: "",
    defaultMode: "phone",
  },
  runtime: {
    sdkFound: false,
    adbFound: false,
    emulatorFound: false,
    aaptFound: false,
    scrcpyFound: false,
    avds: [],
    devices: [],
    issues: [],
  },
};
const modeNames: Record<DeviceMode, string> = { phone: "手机", tv: "电视" };
const pageNames: Record<Page, string> = {
  desktop: "桌面",
  library: "软件库",
  settings: "模拟器设置",
};

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDownload(bytes: number) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(0, bytes / 1024 ** 2).toFixed(1)} MB`;
}

function AppIcon({ app, large = false }: { app: LibraryApp; large?: boolean }) {
  const color =
    [...app.packageName].reduce(
      (total, letter) => total + letter.charCodeAt(0),
      0,
    ) % 6;
  return (
    <div
      className={`app-icon color-${color} ${large ? "large" : ""}`}
      aria-hidden="true"
    >
      {app.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function App() {
  const api = window.apkChecker;
  const [state, setState] = useState<AppState>(initialState);
  const [page, setPage] = useState<Page>("desktop");
  const [mode, setMode] = useState<DeviceMode>("phone");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(!!api);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [draft, setDraft] = useState<Settings>(initialState.settings);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [preparationRequest, setPreparationRequest] =
    useState<ManagedRequest | null>(null);
  const [licenseText, setLicenseText] = useState("");
  const [licenseError, setLicenseError] = useState("");
  const [licenseLoading, setLicenseLoading] = useState(false);
  const [licenseConsent, setLicenseConsent] = useState(false);
  const [preparingMode, setPreparingMode] = useState<DeviceMode | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const cancelledPreparation = useRef(false);
  const prepareCancel = useRef<HTMLButtonElement>(null);
  const initialized = useRef(false);
  const refreshSequence = useRef(0);
  const activeOperation = useRef(false);
  const modalCancel = useRef<HTMLButtonElement>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    const sequence = ++refreshSequence.current;
    const nextState = await api.getState();
    if (sequence !== refreshSequence.current) return;
    setState(nextState);
    if (!initialized.current) {
      setMode(nextState.settings.defaultMode);
      initialized.current = true;
    }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    refresh()
      .catch((error) => {
        if (mounted)
          setNotice({
            type: "error",
            title: "读取应用数据失败",
            details: [String(error)],
          });
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    const unsubscribeProgress = api.onProgress((value) => {
      if (!mounted) return;
      setProgress(value);
      if (value.kind === "error")
        setNotice({
          type: "error",
          title: "运行窗口异常",
          details: [value.message],
        });
    });
    const unsubscribeState = api.onStateChanged(() => {
      refresh().catch((error) => {
        if (mounted)
          setNotice({
            type: "error",
            title: "刷新失败",
            details: [String(error)],
          });
      });
    });
    return () => {
      mounted = false;
      unsubscribeProgress();
      unsubscribeState();
    };
  }, [api, refresh]);

  useEffect(() => {
    setDraft(state.settings);
  }, [
    state.settings.sdkPath,
    state.settings.scrcpyPath,
    state.settings.phoneAvd,
    state.settings.tvAvd,
    state.settings.defaultMode,
  ]);
  useEffect(() => {
    if (!notice || notice.type === "error" || notice.details?.length) return;
    const timeout = window.setTimeout(() => setNotice(null), 6500);
    return () => window.clearTimeout(timeout);
  }, [notice]);
  useEffect(() => {
    if (!confirmation) return;
    modalCancel.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setConfirmation(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmation]);
  useEffect(() => {
    if (!openMenu) return;
    const onClick = () => setOpenMenu(null);
    window.addEventListener("click", onClick);
    return () => window.removeEventListener("click", onClick);
  }, [openMenu]);

  useEffect(() => {
    if (!preparationRequest || !api) return;
    let mounted = true;
    setLicenseConsent(false);
    setLicenseText("");
    setLicenseError("");
    setLicenseLoading(true);
    prepareCancel.current?.focus();
    api
      .getRuntimeLicense()
      .then((text) => {
        if (mounted) setLicenseText(text);
      })
      .catch((error) => {
        if (mounted)
          setLicenseError(
            error instanceof Error ? error.message : String(error),
          );
      })
      .finally(() => {
        if (mounted) setLicenseLoading(false);
      });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreparationRequest(null);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      mounted = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [preparationRequest, api]);

  const selectedAvd =
    mode === "phone" ? state.settings.phoneAvd : state.settings.tvAvd;
  const isInstalled = (app: LibraryApp) =>
    !!selectedAvd && app.installed[mode]?.avd === selectedAvd;
  const installedApps = state.apps.filter(isInstalled);
  const activeDevice = state.runtime.devices.find(
    (device) => device.avd === selectedAvd && device.state === "device",
  );
  const managed = state.managed;
  const modeReady = (deviceMode: DeviceMode) =>
    !!managed?.coreReady &&
    !!(deviceMode === "phone" ? managed.phoneReady : managed.tvReady);
  const environmentReady = modeReady(mode);
  const isPreparing = preparingMode !== null || !!managed?.preparing;
  const progressPercent =
    progress?.totalBytes && progress.completedBytes !== undefined
      ? Math.min(
          100,
          Math.max(0, (progress.completedBytes / progress.totalBytes) * 100),
        )
      : undefined;
  const totalSize = state.apps.reduce((total, app) => total + app.size, 0);
  const baseApps = page === "desktop" ? installedApps : state.apps;
  const shownApps = baseApps.filter((app) => {
    const match = `${app.name} ${app.packageName} ${app.fileName}`
      .toLocaleLowerCase()
      .includes(search.toLocaleLowerCase());
    return (
      match &&
      (page === "desktop" ||
        filter === "all" ||
        (filter === "installed" ? isInstalled(app) : !isInstalled(app)))
    );
  });
  const disabled = !!busy || loading;
  const explainPreview = () =>
    setNotice({
      type: "info",
      title: "请在 APK Checker 桌面应用中操作",
      details: [
        "当前是界面预览。请打开 APK Checker 桌面应用导入文件，模拟器系统会由应用自动准备。",
      ],
    });

  async function runAction(
    key: string,
    action: () => Promise<ActionResult>,
    success: string,
  ) {
    if (activeOperation.current) return;
    if (!api) {
      explainPreview();
      return;
    }
    activeOperation.current = true;
    setBusy(key);
    cancelledPreparation.current = false;
    setCancelRequested(false);
    setProgress(null);
    setNotice(null);
    setOpenMenu(null);
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error || "操作失败，请重试。");
      await refresh();
      setNotice({ type: "success", title: success });
    } catch (error) {
      await refresh().catch(() => undefined);
      setNotice(
        cancelledPreparation.current
          ? {
              type: "info",
              title: "准备已取消",
              details: ["稍后可重新准备模拟器系统。"],
            }
          : {
              type: "error",
              title: "操作未完成",
              details: [error instanceof Error ? error.message : String(error)],
            },
      );
    } finally {
      setBusy(null);
      setProgress(null);
      setPreparingMode(null);
      setCancelRequested(false);
      activeOperation.current = false;
    }
  }

  async function importApks() {
    if (activeOperation.current) return;
    if (!api) {
      explainPreview();
      return;
    }
    activeOperation.current = true;
    setBusy("import");
    setProgress(null);
    setNotice(null);
    try {
      const result = await api.importApks();
      await refresh();
      if (result.imported) {
        setPage("library");
        setSearch("");
        setFilter("all");
      }
      if (result.errors.length || !result.ok) {
        setNotice({
          type: "error",
          title: result.imported
            ? `已导入 ${result.imported} 个应用，部分文件未导入`
            : "导入未完成",
          details: result.errors.length
            ? result.errors
            : [result.error || "请检查 APK 文件是否完整。"],
        });
      } else if (result.imported)
        setNotice({
          type: result.warnings?.length ? "info" : "success",
          title: `已导入 ${result.imported} 个应用`,
          details: result.warnings,
        });
    } catch (error) {
      setNotice({
        type: "error",
        title: "导入未完成",
        details: [error instanceof Error ? error.message : String(error)],
      });
    } finally {
      setBusy(null);
      setProgress(null);
      activeOperation.current = false;
    }
  }

  function navigate(next: Page) {
    setPage(next);
    setSearch("");
    setFilter("all");
    setOpenMenu(null);
  }
  async function refreshRuntime() {
    if (!api) {
      explainPreview();
      return;
    }
    await runAction(
      "refresh",
      async () => {
        const runtime = await api.refreshRuntime();
        setState((previous) => ({ ...previous, runtime }));
        return { ok: true };
      },
      "模拟器状态已刷新",
    );
  }
  function requestManagedAction(request: ManagedRequest) {
    if (activeOperation.current || loading) return;
    if (!api) {
      explainPreview();
      return;
    }
    if (!managed) {
      setNotice({
        type: "error",
        title: "无法读取模拟器状态",
        details: ["请刷新模拟器状态后重试。"],
      });
      return;
    }
    if (!managed.supported) {
      setNotice({
        type: "error",
        title: "当前系统暂不支持模拟器",
        details: [managed.error || "仍可导入和管理 APK 文件。"],
      });
      return;
    }
    if (!managed.licenseAccepted) {
      setPreparationRequest(request);
      return;
    }
    void executeManagedAction(request, false);
  }

  async function executeManagedAction(
    request: ManagedRequest,
    acceptLicense: boolean,
  ) {
    if (!api) {
      explainPreview();
      return;
    }
    const { action, mode: requestedMode, app } = request;
    const success =
      action === "prepare"
        ? `${modeNames[requestedMode]}模拟器已准备好`
        : action === "install"
          ? `${app!.name} 已安装到${modeNames[requestedMode]}桌面`
          : action === "launch"
            ? `${app!.name} 已在独立窗口打开`
            : "应用已卸载";
    await runAction(
      `${action}-${app?.id || requestedMode}`,
      async () => {
        if (!modeReady(requestedMode) || acceptLicense) {
          setPreparingMode(requestedMode);
          try {
            const prepared = await api.prepareEnvironment(
              requestedMode,
              acceptLicense,
            );
            if (!prepared.ok) return prepared;
            if (cancelledPreparation.current)
              return { ok: false, error: "准备已取消" };
          } finally {
            setPreparingMode(null);
          }
        }
        if (action === "prepare") return { ok: true };
        if (action === "install") return api.installApp(app!.id, requestedMode);
        if (action === "launch") return api.launchApp(app!.id, requestedMode);
        return api.uninstallApp(app!.id, requestedMode);
      },
      success,
    );
  }

  async function cancelPreparation() {
    if (!api || cancelRequested) return;
    cancelledPreparation.current = true;
    setCancelRequested(true);
    try {
      const result = await api.cancelPreparation();
      if (!result.ok)
        throw new Error(result.error || "无法取消准备，请稍后重试。");
    } catch (error) {
      cancelledPreparation.current = false;
      setCancelRequested(false);
      setNotice({
        type: "error",
        title: "取消未完成",
        details: [error instanceof Error ? error.message : String(error)],
      });
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate("desktop");
          }}
          aria-label="APK Checker 首页"
        >
          <span className="brand-icon">
            <Box size={23} strokeWidth={1.8} />
          </span>
          <span>
            APK Checker<small>你的 Android 应用空间</small>
          </span>
        </a>
        <div className="nav-label">工作空间</div>
        <nav className="main-nav" aria-label="主导航">
          <button
            className={page === "desktop" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("desktop")}
            aria-current={page === "desktop" ? "page" : undefined}
          >
            <LayoutGrid size={19} />
            <span>桌面</span>
            {installedApps.length > 0 && (
              <span className="nav-count">{installedApps.length}</span>
            )}
          </button>
          <button
            className={page === "library" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("library")}
            aria-current={page === "library" ? "page" : undefined}
          >
            <Package size={19} />
            <span>软件库</span>
            {state.apps.length > 0 && (
              <span className="nav-count">{state.apps.length}</span>
            )}
          </button>
          <button
            className={page === "settings" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("settings")}
            aria-current={page === "settings" ? "page" : undefined}
          >
            <Settings2 size={19} />
            <span>模拟器设置</span>
          </button>
        </nav>
        <div className="sidebar-note">
          <div className="note-symbol">
            <Sparkles size={17} />
          </div>
          <p>一个应用，两种体验</p>
          <span>
            在手机与电视之间切换，
            <br />
            发现应用的更多可能。
          </span>
          <div className="note-devices">
            <Smartphone size={23} />
            <span>+</span>
            <Tv size={29} />
          </div>
        </div>
        <div className="sidebar-bottom">
          <button
            className="environment-shortcut"
            onClick={() => navigate("settings")}
          >
            <span className={`status-dot ${environmentReady ? "green" : ""}`} />
            <span>
              模拟器
              <small>{environmentReady ? "已就绪" : "首次使用自动准备"}</small>
            </span>
            <ArrowRight size={15} />
          </button>
          <div className="version">
            <span>APK Checker</span>
            <span>v{appVersion}</span>
          </div>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <div className="breadcrumb">
            <Box size={15} />
            <span>工作空间</span>
            <span className="separator">/</span>
            <strong>{pageNames[page]}</strong>
          </div>
          <div className="topbar-right">
            {!api && <span className="preview-badge">浏览器预览</span>}
            <span className="local-badge">
              <ShieldCheck size={14} />
              本地运行
            </span>
          </div>
        </div>
        <div className="page-content">
          <header className="page-header">
            <div>
              <div className="eyebrow">
                {page === "desktop"
                  ? "YOUR ANDROID WORKSPACE"
                  : page === "library"
                    ? "APPLICATION LIBRARY"
                    : "EMULATOR SETTINGS"}
              </div>
              <h1>
                {pageNames[page]}
                <span className="heading-dot">.</span>
              </h1>
              <p>
                {page === "desktop"
                  ? "所有已安装的应用，随时点开，在独立窗口体验。"
                  : page === "library"
                    ? "把 APK 放进来，让每个应用都有自己的位置。"
                    : "系统自动准备，应用自由体验。"}
              </p>
            </div>
            <button
              className="button primary import-button"
              onClick={importApks}
              disabled={disabled}
            >
              {busy === "import" ? (
                <LoaderCircle className="spin" size={17} />
              ) : (
                <Plus size={18} />
              )}
              导入 APK
            </button>
          </header>

          {busy && (
            <div className="operation-banner managed-progress" role="status">
              <div className="operation-message">
                <LoaderCircle className="spin" size={17} />
                <span>
                  {progress?.message ||
                    (busy === "import"
                      ? "正在导入 APK…"
                      : busy === "refresh"
                        ? "正在检查模拟器状态…"
                        : isPreparing
                          ? "正在准备模拟器系统…"
                          : "正在处理，请稍候…")}
                </span>
                {isPreparing && (
                  <button
                    className="text-button"
                    onClick={cancelPreparation}
                    disabled={cancelRequested}
                  >
                    {cancelRequested ? "正在取消…" : "取消准备"}
                  </button>
                )}
              </div>
              {isPreparing && (
                <div className="download-progress">
                  <div
                    className="download-track"
                    role="progressbar"
                    aria-label="模拟器准备进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={
                      progressPercent === undefined
                        ? undefined
                        : Math.round(progressPercent)
                    }
                  >
                    <span
                      className={
                        progressPercent === undefined ? "indeterminate" : ""
                      }
                      style={
                        progressPercent === undefined
                          ? undefined
                          : { width: `${progressPercent}%` }
                      }
                    />
                  </div>
                  <span>
                    {progressPercent !== undefined
                      ? `${formatDownload(progress!.completedBytes!)} / ${formatDownload(progress!.totalBytes!)}`
                      : "正在下载、校验或解压所需文件"}
                  </span>
                </div>
              )}
            </div>
          )}

          {page !== "settings" && (
            <>
              <section className="workspace-toolbar" aria-label="应用视图设置">
                <div className="mode-control">
                  <span className="toolbar-label">运行模式</span>
                  <div className="segmented" role="group" aria-label="运行模式">
                    <button
                      aria-pressed={mode === "phone"}
                      className={mode === "phone" ? "selected" : ""}
                      onClick={() => setMode("phone")}
                      disabled={disabled}
                    >
                      <Smartphone size={16} />
                      手机模式
                    </button>
                    <button
                      aria-pressed={mode === "tv"}
                      className={mode === "tv" ? "selected" : ""}
                      onClick={() => setMode("tv")}
                      disabled={disabled}
                    >
                      <Tv size={17} />
                      电视模式
                    </button>
                  </div>
                </div>
                <div className="device-status">
                  <span
                    className={`status-dot ${activeDevice ? "green" : ""}`}
                  />
                  {activeDevice
                    ? "设备运行中"
                    : environmentReady
                      ? "模拟器待启动"
                      : "首次使用自动准备"}
                  <span className="device-status-divider" />
                  <button
                    onClick={() => navigate("settings")}
                    aria-label="模拟器设置"
                  >
                    <Settings2 size={15} />
                  </button>
                </div>
              </section>
              <div className="section-heading">
                <div>
                  <h2>{page === "desktop" ? "我的应用" : "全部应用"}</h2>
                  <span className="number-badge">{baseApps.length}</span>
                  {page === "desktop" && (
                    <span className="mode-caption">{modeNames[mode]}桌面</span>
                  )}
                </div>
                <div className="list-tools">
                  {page === "library" && (
                    <div className="select-wrap filter-select">
                      <select
                        aria-label="按安装状态筛选"
                        value={filter}
                        onChange={(event) => setFilter(event.target.value)}
                      >
                        <option value="all">全部状态</option>
                        <option value="installed">已安装</option>
                        <option value="uninstalled">未安装</option>
                      </select>
                      <ChevronDown size={14} />
                    </div>
                  )}
                  <label className="search-input">
                    <Search size={16} />
                    <input
                      placeholder="搜索应用…"
                      aria-label="搜索应用"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                    {search && (
                      <button
                        onClick={() => setSearch("")}
                        aria-label="清除搜索"
                      >
                        <X size={13} />
                      </button>
                    )}
                  </label>
                </div>
              </div>

              {loading ? (
                <div className="loading-state">
                  <LoaderCircle className="spin" size={24} />
                  <p>正在读取你的应用空间…</p>
                </div>
              ) : shownApps.length ? (
                <div
                  className={`app-grid ${page === "desktop" ? "desktop-grid" : ""}`}
                >
                  {shownApps.map((app) => (
                    <article className="application-card" key={app.id}>
                      <div className="app-card-top">
                        <AppIcon app={app} large />
                        <div className="app-menu-wrap">
                          <button
                            className="icon-button more-button"
                            aria-label={`${app.name} 更多操作`}
                            aria-expanded={openMenu === app.id}
                            onClick={(event) => {
                              event.stopPropagation();
                              setOpenMenu(openMenu === app.id ? null : app.id);
                            }}
                            disabled={disabled}
                          >
                            <MoreHorizontal size={20} />
                          </button>
                          {openMenu === app.id && (
                            <div
                              className="app-menu"
                              onClick={(event) => event.stopPropagation()}
                            >
                              {isInstalled(app) && (
                                <button
                                  onClick={() => {
                                    setConfirmation({ type: "uninstall", app });
                                    setOpenMenu(null);
                                  }}
                                >
                                  <ArrowDownToLine size={15} />
                                  卸载此设备上的应用
                                </button>
                              )}
                              <button
                                className="danger-text"
                                disabled={Object.values(app.installed).some(
                                  Boolean,
                                )}
                                title={
                                  Object.values(app.installed).some(Boolean)
                                    ? "请先卸载手机和电视设备上的应用，再移除 APK"
                                    : "移除保存的 APK 文件"
                                }
                                onClick={() => {
                                  setConfirmation({ type: "remove", app });
                                  setOpenMenu(null);
                                }}
                              >
                                <Trash2 size={15} />
                                {Object.values(app.installed).some(Boolean)
                                  ? "卸载后可移除"
                                  : "从软件库移除"}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                      <h3 title={app.name}>{app.name}</h3>
                      <p className="package-name" title={app.packageName}>
                        {app.packageName}
                      </p>
                      <div className="app-metadata">
                        <span>
                          v{app.versionName || app.versionCode || "—"}
                        </span>
                        <span className="metadata-dot" />
                        <span>{formatSize(app.size)}</span>
                      </div>
                      <div className="app-card-bottom">
                        <span
                          className={`app-status ${isInstalled(app) ? "installed" : ""}`}
                        >
                          {isInstalled(app) ? (
                            <CheckCircle2 size={13} />
                          ) : (
                            <Circle size={12} />
                          )}
                          {isInstalled(app) ? "已安装" : "待安装"}
                        </span>
                        <button
                          className={
                            isInstalled(app)
                              ? "button small open-button"
                              : "button small install-button"
                          }
                          disabled={disabled}
                          onClick={() =>
                            requestManagedAction({
                              action: isInstalled(app) ? "launch" : "install",
                              mode,
                              app,
                            })
                          }
                        >
                          {busy?.endsWith(app.id) ? (
                            <LoaderCircle className="spin" size={14} />
                          ) : isInstalled(app) ? (
                            <Play size={13} fill="currentColor" />
                          ) : (
                            <ArrowDownToLine size={14} />
                          )}
                          {isInstalled(app) ? "打开" : "安装"}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : search || (page === "library" && filter !== "all") ? (
                <div className="empty-state search-empty">
                  <div className="empty-search-icon">
                    <Search size={30} />
                  </div>
                  <h3>没有找到匹配的应用</h3>
                  <p>换个关键词，或试试其他安装状态。</p>
                  <button
                    className="button secondary"
                    onClick={() => {
                      setSearch("");
                      setFilter("all");
                    }}
                  >
                    清除筛选
                  </button>
                </div>
              ) : (
                <section className="empty-state">
                  <div
                    className={`device-illustration ${mode === "tv" ? "tv-illustration" : ""}`}
                    aria-hidden="true"
                  >
                    <div className="illustration-halo" />
                    <div className="orbit orbit-one" />
                    <div className="orbit orbit-two" />
                    <div className="floating-app floating-one">
                      <Package size={23} />
                    </div>
                    <div className="floating-app floating-two">
                      <Play size={17} fill="currentColor" />
                    </div>
                    <div className="illustrated-device">
                      <span className="device-camera" />
                      <div className="device-grid">
                        <span />
                        <span />
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                      <div className="device-plus">
                        <Plus size={22} />
                      </div>
                      <div className="device-home" />
                    </div>
                    <span className="illustration-spark spark-one">+</span>
                    <span className="illustration-spark spark-two">+</span>
                  </div>
                  <div className="empty-copy">
                    <span className="empty-kicker">
                      一切精彩，从一个 APK 开始
                    </span>
                    <h2>
                      {page === "library"
                        ? "你的应用收藏，从这里开始"
                        : state.apps.length
                          ? `给${modeNames[mode]}桌面装上第一个应用`
                          : "让 Android 应用，来到你的桌面"}
                    </h2>
                    <p>
                      {page === "desktop" && state.apps.length
                        ? `软件库中有 ${state.apps.length} 个应用，选择一个安装到${modeNames[mode]}设备。`
                        : "导入喜欢的应用，在手机或电视模式下自由体验。"}
                      <br />
                      {page === "library"
                        ? "支持批量导入 .apk 文件，应用文件会保存在本机。"
                        : "安装后的应用会出现在这里，点击即可在独立窗口打开。"}
                    </p>
                  </div>
                  <div className="empty-actions">
                    <button
                      className="button primary"
                      onClick={
                        page === "desktop" && state.apps.length
                          ? () => navigate("library")
                          : importApks
                      }
                      disabled={disabled}
                    >
                      {page === "desktop" && state.apps.length ? (
                        <Package size={16} />
                      ) : (
                        <Upload size={16} />
                      )}
                      {page === "desktop" && state.apps.length
                        ? "前往软件库"
                        : "导入第一个 APK"}
                    </button>
                    <button
                      className="text-button"
                      onClick={() => navigate("settings")}
                    >
                      模拟器设置
                      <ArrowRight size={15} />
                    </button>
                  </div>
                  <div className="empty-footnote">
                    <ShieldCheck size={13} />
                    所有文件保留在你的设备上
                  </div>
                </section>
              )}

              {baseApps.length === 0 && !search && (
                <section className="getting-started">
                  <div className="guide-heading">
                    <h2>三步，开启你的应用空间</h2>
                    <span>QUICK START</span>
                  </div>
                  <div className="steps">
                    <button
                      className="step-card"
                      onClick={importApks}
                      disabled={disabled}
                    >
                      <span className="step-icon">
                        <Import size={21} />
                      </span>
                      <div>
                        <h3>
                          <span>01</span>导入 APK
                        </h3>
                        <p>选择本机 APK 文件，添加到软件库</p>
                      </div>
                      <ArrowRight className="step-arrow" size={16} />
                    </button>
                    <button
                      className="step-card"
                      onClick={() => navigate("settings")}
                    >
                      <span className="step-icon">
                        <Smartphone size={21} />
                      </span>
                      <div>
                        <h3>
                          <span>02</span>选择模式并安装
                        </h3>
                        <p>选择手机或电视，系统会自动准备</p>
                      </div>
                      <ArrowRight className="step-arrow" size={16} />
                    </button>
                    <button
                      className="step-card"
                      onClick={() => navigate("library")}
                    >
                      <span className="step-icon">
                        <ExternalLink size={20} />
                      </span>
                      <div>
                        <h3>
                          <span>03</span>独立窗口打开
                        </h3>
                        <p>从桌面启动，开始体验 Android 应用</p>
                      </div>
                      <ArrowRight className="step-arrow" size={16} />
                    </button>
                  </div>
                </section>
              )}
              {baseApps.length > 0 && (
                <div className="list-footer">
                  <span>
                    {page === "desktop"
                      ? `${installedApps.length} 个应用已安装到当前${modeNames[mode]}设备`
                      : `${state.apps.length} 个应用 · 共 ${formatSize(totalSize)}`}
                  </span>
                  <span>
                    <HardDrive size={13} />
                    存储于本机
                  </span>
                </div>
              )}
            </>
          )}

          {page === "settings" && (
            <div className="managed-settings">
              <section className="managed-intro settings-card">
                <div className="settings-section-heading">
                  <div className="settings-title">
                    <span className="settings-icon">
                      <Sparkles size={20} />
                    </span>
                    <div>
                      <h2>打开应用，其余交给模拟器</h2>
                      <p>
                        导入 APK 即可管理，首次安装时自动准备所选 Android 系统。
                      </p>
                    </div>
                  </div>
                  <button
                    className="button secondary small"
                    onClick={refreshRuntime}
                    disabled={disabled}
                  >
                    <RefreshCw
                      size={14}
                      className={busy === "refresh" ? "spin" : ""}
                    />
                    刷新状态
                  </button>
                </div>
                <div className="managed-capabilities">
                  <div>
                    <CheckCircle2 size={19} />
                    <strong>APK 解析已内置</strong>
                    <span>无需安装开发工具，直接导入文件</span>
                  </div>
                  <div>
                    <Box size={19} />
                    <strong>运行文件自动管理</strong>
                    <span>应用负责准备、校验和保存所需组件</span>
                  </div>
                  <div>
                    <HardDrive size={19} />
                    <strong>准备一次，保留在本机</strong>
                    <span>系统准备完成后可离线启动</span>
                  </div>
                </div>
                {!api && (
                  <p className="managed-preview-note">
                    当前是浏览器界面预览；请在桌面应用中准备和运行模拟器。
                  </p>
                )}
                {managed?.supported === false && (
                  <div className="runtime-issues" role="alert">
                    <CircleAlert size={16} />
                    <p>
                      {managed.error ||
                        "当前操作系统或处理器暂不支持模拟器，仍可导入 APK。"}
                    </p>
                  </div>
                )}
                {managed?.error && managed.supported && (
                  <div className="runtime-issues" role="alert">
                    <CircleAlert size={16} />
                    <p>{managed.error}</p>
                  </div>
                )}
              </section>
              <div className="managed-device-grid">
                {(["phone", "tv"] as const).map((deviceMode) => {
                  const ready = modeReady(deviceMode);
                  const preparing =
                    preparingMode === deviceMode ||
                    managed?.preparing === deviceMode;
                  const downloadBytes = managed?.downloadBytes[deviceMode] || 0;
                  return (
                    <section
                      className={`settings-card managed-device-card ${deviceMode}`}
                      key={deviceMode}
                    >
                      <div className="managed-device-heading">
                        <span className="managed-device-icon">
                          {deviceMode === "phone" ? (
                            <Smartphone size={29} />
                          ) : (
                            <Tv size={32} />
                          )}
                        </span>
                        <span
                          className={`dependency-tag ${ready ? "ready" : ""}`}
                        >
                          {preparing ? "准备中" : ready ? "已就绪" : "待准备"}
                        </span>
                      </div>
                      <h2>{modeNames[deviceMode]}模拟器</h2>
                      <p>
                        {deviceMode === "phone"
                          ? "适合触摸操作与手机应用"
                          : "适合大屏应用与方向键操作"}
                      </p>
                      <div className="managed-device-detail">
                        <span>系统</span>
                        <strong>
                          {deviceMode === "phone"
                            ? "Android 11"
                            : "Android TV 16"}
                        </strong>
                      </div>
                      <div className="managed-device-detail">
                        <span>{ready ? "启动方式" : "预计下载"}</span>
                        <strong>
                          {ready
                            ? "可离线启动"
                            : downloadBytes
                              ? `约 ${formatDownload(downloadBytes)}`
                              : "准备前自动检测"}
                        </strong>
                      </div>
                      <button
                        className={`button ${ready ? "secondary" : "primary"}`}
                        disabled={
                          disabled || ready || managed?.supported === false
                        }
                        onClick={() =>
                          requestManagedAction({
                            action: "prepare",
                            mode: deviceMode,
                          })
                        }
                      >
                        {preparing ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : ready ? (
                          <CheckCircle2 size={16} />
                        ) : (
                          <ArrowDownToLine size={16} />
                        )}
                        {preparing
                          ? "正在准备…"
                          : ready
                            ? "系统已准备好"
                            : `准备${modeNames[deviceMode]}模式`}
                      </button>
                    </section>
                  );
                })}
              </div>
              <form
                className="settings-card managed-preferences"
                onSubmit={(event) => {
                  event.preventDefault();
                  runAction(
                    "settings",
                    () => api!.saveSettings(draft),
                    "设置已保存",
                  );
                }}
              >
                <div>
                  <h2>默认运行模式</h2>
                  <p>下次打开 APK Checker 时优先显示这个桌面。</p>
                </div>
                <label className="select-wrap">
                  <span className="visually-hidden">默认运行模式</span>
                  <select
                    aria-label="默认运行模式"
                    value={draft.defaultMode}
                    disabled={disabled}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        defaultMode: event.target.value as DeviceMode,
                      })
                    }
                  >
                    <option value="phone">手机模式</option>
                    <option value="tv">电视模式</option>
                  </select>
                  <ChevronDown size={15} />
                </label>
                <button
                  type="submit"
                  className="button primary"
                  disabled={disabled}
                >
                  <Check size={16} />
                  保存设置
                </button>
              </form>
              <aside className="managed-help">
                <Monitor size={19} />
                <div>
                  <h3>自动准备，无需配置路径</h3>
                  <p>
                    首次使用需要联网下载 Android
                    核心和系统镜像，并接受适用许可；请预留足够的磁盘空间。下载后由应用自动校验和创建模拟器，之后无需再次下载完整系统。
                  </p>
                  <p>
                    同一模式共用一台模拟器，打开其他应用会切换前台画面。APK
                    能否运行取决于 Android 版本、原生库架构及电视适配情况。
                  </p>
                </div>
              </aside>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <Box size={13} />
              为每一个 Android 应用，留一席之地。
            </span>
            <span>LOCAL FIRST · YOUR APPS, YOUR SPACE</span>
          </footer>
        </div>
      </main>

      {notice && (
        <div
          className={`toast ${notice.type}`}
          role={notice.type === "error" ? "alert" : "status"}
        >
          <div className="toast-icon">
            {notice.type === "success" ? (
              <CheckCircle2 size={20} />
            ) : (
              <CircleAlert size={20} />
            )}
          </div>
          <div className="toast-content">
            <strong>{notice.title}</strong>
            {notice.details?.map((detail, index) => (
              <p key={index}>{detail}</p>
            ))}
          </div>
          <button
            className="icon-button"
            onClick={() => setNotice(null)}
            aria-label="关闭通知"
          >
            <X size={17} />
          </button>
        </div>
      )}
      {preparationRequest && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget)
              setPreparationRequest(null);
          }}
        >
          <div
            className="confirm-dialog prepare-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="prepare-title"
            aria-describedby="prepare-description"
            onKeyDown={(event) => {
              if (event.key !== "Tab") return;
              const controls = Array.from(
                event.currentTarget.querySelectorAll<HTMLElement>(
                  'button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]',
                ),
              );
              const first = controls[0];
              const last = controls[controls.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
              }
            }}
          >
            <span className="prepare-icon">
              {preparationRequest.mode === "phone" ? (
                <Smartphone size={27} />
              ) : (
                <Tv size={29} />
              )}
            </span>
            <h2 id="prepare-title">
              准备{modeNames[preparationRequest.mode]}模拟器
            </h2>
            <p id="prepare-description">
              {modeReady(preparationRequest.mode) ? (
                "系统文件已保存在本机，请确认当前许可后继续。"
              ) : (
                <>
                  应用会从官方来源下载 Android
                  核心和所选系统，自动校验并保存在本机。
                  {managed?.downloadBytes[preparationRequest.mode]
                    ? `本次预计下载约 ${formatDownload(managed.downloadBytes[preparationRequest.mode])}。`
                    : "系统镜像较大，请保持联网并预留足够磁盘空间。"}
                  准备完成后可离线启动。
                </>
              )}
            </p>
            {preparationRequest.app && (
              <div className="prepare-next">
                <Package size={16} />
                <span>
                  准备后继续
                  {preparationRequest.action === "install"
                    ? "安装"
                    : preparationRequest.action === "launch"
                      ? "打开"
                      : "卸载"}
                  「{preparationRequest.app.name}」
                </span>
              </div>
            )}
            {licenseLoading ? (
              <div className="license-loading" role="status">
                <LoaderCircle className="spin" size={16} />
                正在读取许可条款…
              </div>
            ) : licenseError ? (
              <div className="runtime-issues" role="alert">
                <CircleAlert size={16} />
                <span>{licenseError}</span>
              </div>
            ) : (
              <details className="license-details">
                <summary>查看 Android 运行环境许可条款</summary>
                <pre tabIndex={0}>{licenseText}</pre>
              </details>
            )}
            <label className="license-consent">
              <input
                type="checkbox"
                checked={licenseConsent}
                disabled={licenseLoading || !!licenseError || !licenseText}
                onChange={(event) => setLicenseConsent(event.target.checked)}
              />
              <span>我已阅读并同意上述许可条款</span>
            </label>
            <div className="confirm-actions">
              <button
                ref={prepareCancel}
                className="button secondary"
                onClick={() => setPreparationRequest(null)}
              >
                暂不准备
              </button>
              <button
                className="button primary"
                disabled={
                  !licenseConsent ||
                  licenseLoading ||
                  !!licenseError ||
                  !licenseText
                }
                onClick={() => {
                  const request = preparationRequest;
                  setPreparationRequest(null);
                  void executeManagedAction(request, true);
                }}
              >
                <ArrowDownToLine size={16} />
                同意并准备
              </button>
            </div>
          </div>
        </div>
      )}
      {confirmation && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setConfirmation(null);
          }}
        >
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-description"
            onKeyDown={(event) => {
              if (event.key === "Tab") {
                const buttons = event.currentTarget.querySelectorAll("button");
                const first = buttons[0];
                const last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }
            }}
          >
            <span className="confirm-icon">
              <Trash2 size={23} />
            </span>
            <h2 id="confirm-title">
              {confirmation.type === "remove"
                ? "从软件库移除应用？"
                : `从${modeNames[mode]}设备卸载应用？`}
            </h2>
            <p id="confirm-description">
              {confirmation.type === "remove"
                ? `将移除「${confirmation.app.name}」的软件库记录及保存的 APK 副本。原始 APK 文件不受影响。`
                : `将从当前${modeNames[mode]}设备卸载「${confirmation.app.name}」，该设备上的应用数据也会被删除。软件库中的 APK 会保留。`}
            </p>
            <div className="confirm-actions">
              <button
                ref={modalCancel}
                className="button secondary"
                onClick={() => setConfirmation(null)}
              >
                取消
              </button>
              <button
                className="button danger"
                onClick={() => {
                  const current = confirmation;
                  setConfirmation(null);
                  if (current.type === "uninstall")
                    requestManagedAction({
                      action: "uninstall",
                      mode,
                      app: current.app,
                    });
                  else
                    runAction(
                      `remove-${current.app.id}`,
                      () => api!.removeApp(current.app.id),
                      "已从软件库移除应用",
                    );
                }}
              >
                {confirmation.type === "remove" ? "确认移除" : "确认卸载"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
