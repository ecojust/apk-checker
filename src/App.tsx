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
  FolderOpen,
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
  Terminal,
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
  settings: "运行环境",
};

function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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

  const selectedAvd =
    mode === "phone" ? state.settings.phoneAvd : state.settings.tvAvd;
  const isInstalled = (app: LibraryApp) =>
    !!selectedAvd && app.installed[mode]?.avd === selectedAvd;
  const installedApps = state.apps.filter(isInstalled);
  const activeDevice = state.runtime.devices.find(
    (device) => device.avd === selectedAvd && device.state === "device",
  );
  const environmentReady =
    state.runtime.adbFound &&
    state.runtime.emulatorFound &&
    state.runtime.scrcpyFound &&
    !!selectedAvd &&
    state.runtime.avds.includes(selectedAvd);
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
        "当前是界面预览。导入、安装和运行 APK 需要桌面应用连接本机 Android 环境。",
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
    setProgress(null);
    setNotice(null);
    setOpenMenu(null);
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error || "操作失败，请重试。");
      await refresh();
      setNotice({ type: "success", title: success });
    } catch (error) {
      setNotice({
        type: "error",
        title: "操作未完成",
        details: [error instanceof Error ? error.message : String(error)],
      });
    } finally {
      setBusy(null);
      setProgress(null);
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
            : [result.error || "请检查 APK 文件和运行环境。"],
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
      "运行环境已刷新",
    );
  }
  async function choosePath(kind: "sdk" | "scrcpy") {
    if (!api) {
      explainPreview();
      return;
    }
    try {
      const path = await api.choosePath(kind);
      if (path)
        setDraft((previous) => ({
          ...previous,
          [kind === "sdk" ? "sdkPath" : "scrcpyPath"]: path,
        }));
    } catch (error) {
      setNotice({
        type: "error",
        title: "无法选择路径",
        details: [String(error)],
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
            <span>运行环境</span>
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
              运行环境<small>{environmentReady ? "已就绪" : "等待配置"}</small>
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
                    : "RUNTIME CONFIGURATION"}
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
                    : "连接你的 Android 环境，准备好下一次运行。"}
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
            <div className="operation-banner" role="status">
              <LoaderCircle className="spin" size={17} />
              <span>
                {progress?.message ||
                  (busy === "import"
                    ? "正在导入 APK…"
                    : busy === "refresh"
                      ? "正在检查运行环境…"
                      : "正在处理，请稍候…")}
              </span>
              <small>首次启动虚拟设备可能需要几分钟</small>
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
                    : selectedAvd
                      ? "设备待启动"
                      : "尚未选择设备"}
                  <span className="device-status-divider" />
                  <button
                    onClick={() => navigate("settings")}
                    aria-label="配置运行设备"
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
                            isInstalled(app)
                              ? runAction(
                                  `launch-${app.id}`,
                                  () => api!.launchApp(app.id, mode),
                                  `${app.name} 已在独立窗口打开`,
                                )
                              : runAction(
                                  `install-${app.id}`,
                                  () => api!.installApp(app.id, mode),
                                  `${app.name} 已安装到${modeNames[mode]}桌面`,
                                )
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
                      配置运行环境
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
                          <span>02</span>选择设备并安装
                        </h3>
                        <p>配置手机或电视设备，安装你的应用</p>
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
            <div className="settings-layout">
              <section className="settings-card environment-card">
                <div className="settings-section-heading">
                  <div className="settings-title">
                    <span className="settings-icon">
                      <Terminal size={19} />
                    </span>
                    <div>
                      <h2>环境检查</h2>
                      <p>运行真实的 Android 应用，需要以下本机组件。</p>
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
                    重新检测
                  </button>
                </div>
                <div className="dependency-list">
                  {[
                    {
                      name: "Android SDK",
                      detail: "Android 开发工具目录",
                      ok: state.runtime.sdkFound,
                    },
                    {
                      name: "ADB",
                      detail: "设备连接与应用安装",
                      ok: state.runtime.adbFound,
                    },
                    {
                      name: "Android Emulator",
                      detail: "手机与电视虚拟设备",
                      ok: state.runtime.emulatorFound,
                    },
                    {
                      name: "AAPT",
                      detail: "读取 APK 名称与包信息",
                      ok: state.runtime.aaptFound,
                    },
                    {
                      name: "scrcpy",
                      detail: "独立窗口显示与交互",
                      ok: state.runtime.scrcpyFound,
                    },
                  ].map((dependency) => (
                    <div className="dependency" key={dependency.name}>
                      <div
                        className={`dependency-check ${dependency.ok ? "ready" : ""}`}
                      >
                        {dependency.ok ? (
                          <Check size={15} />
                        ) : (
                          <Circle size={13} />
                        )}
                      </div>
                      <div>
                        <strong>{dependency.name}</strong>
                        <span>{dependency.detail}</span>
                      </div>
                      <span
                        className={`dependency-tag ${dependency.ok ? "ready" : ""}`}
                      >
                        {dependency.ok ? "已就绪" : "未检测到"}
                      </span>
                    </div>
                  ))}
                </div>
                {state.runtime.issues.length > 0 && (
                  <div className="runtime-issues">
                    <CircleAlert size={16} />
                    <div>
                      {state.runtime.issues.map((issue, index) => (
                        <p key={index}>{issue}</p>
                      ))}
                    </div>
                  </div>
                )}
              </section>
              <form
                className="settings-card configuration-card"
                onSubmit={(event) => {
                  event.preventDefault();
                  runAction(
                    "settings",
                    () => api!.saveSettings(draft),
                    "设置已保存",
                  );
                }}
              >
                <div className="settings-section-heading">
                  <div className="settings-title">
                    <span className="settings-icon">
                      <FolderOpen size={19} />
                    </span>
                    <div>
                      <h2>工具与设备</h2>
                      <p>保存后自动重新检测，可留空工具路径以使用自动发现。</p>
                    </div>
                  </div>
                </div>
                <div className="settings-form">
                  <label className="form-field">
                    <span>Android SDK 路径</span>
                    <div className="path-input">
                      <input
                        value={draft.sdkPath}
                        onChange={(event) =>
                          setDraft({ ...draft, sdkPath: event.target.value })
                        }
                        placeholder="自动检测 ANDROID_HOME 或默认安装目录"
                        disabled={disabled}
                      />
                      <button
                        type="button"
                        onClick={() => choosePath("sdk")}
                        disabled={disabled}
                        aria-label="选择 Android SDK 目录"
                      >
                        <FolderOpen size={17} />
                      </button>
                    </div>
                    <small>
                      选择包含 platform-tools、emulator 和 build-tools 的 SDK
                      目录。
                    </small>
                  </label>
                  <label className="form-field">
                    <span>scrcpy 路径</span>
                    <div className="path-input">
                      <input
                        value={draft.scrcpyPath}
                        onChange={(event) =>
                          setDraft({ ...draft, scrcpyPath: event.target.value })
                        }
                        placeholder="自动检测 scrcpy 可执行文件"
                        disabled={disabled}
                      />
                      <button
                        type="button"
                        onClick={() => choosePath("scrcpy")}
                        disabled={disabled}
                        aria-label="选择 scrcpy 可执行文件"
                      >
                        <FolderOpen size={17} />
                      </button>
                    </div>
                    <small>
                      macOS 可使用 Homebrew 安装；Windows 选择 scrcpy.exe。
                    </small>
                  </label>
                  <div className="form-divider" />
                  <div className="device-fields">
                    <label className="form-field">
                      <span>
                        <Smartphone size={15} />
                        手机虚拟设备
                      </span>
                      <div className="select-wrap">
                        <select
                          value={draft.phoneAvd}
                          onChange={(event) =>
                            setDraft({ ...draft, phoneAvd: event.target.value })
                          }
                          disabled={disabled}
                        >
                          <option value="">选择手机 AVD</option>
                          {Array.from(
                            new Set([
                              ...state.runtime.avds,
                              ...(draft.phoneAvd ? [draft.phoneAvd] : []),
                            ]),
                          ).map((avd) => (
                            <option key={avd} value={avd}>
                              {avd}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                    </label>
                    <label className="form-field">
                      <span>
                        <Tv size={16} />
                        电视虚拟设备
                      </span>
                      <div className="select-wrap">
                        <select
                          value={draft.tvAvd}
                          onChange={(event) =>
                            setDraft({ ...draft, tvAvd: event.target.value })
                          }
                          disabled={disabled}
                        >
                          <option value="">选择 Android TV AVD</option>
                          {Array.from(
                            new Set([
                              ...state.runtime.avds,
                              ...(draft.tvAvd ? [draft.tvAvd] : []),
                            ]),
                          ).map((avd) => (
                            <option key={avd} value={avd}>
                              {avd}
                            </option>
                          ))}
                        </select>
                        <ChevronDown size={15} />
                      </div>
                    </label>
                  </div>
                  <p className="field-note">
                    请先在 Android Studio 的 Device Manager
                    中创建对应设备。电视模式需要 Android TV 系统镜像。
                  </p>
                  <label className="form-field default-mode">
                    <span>默认运行模式</span>
                    <div className="select-wrap">
                      <select
                        value={draft.defaultMode}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            defaultMode: event.target.value as DeviceMode,
                          })
                        }
                        disabled={disabled}
                      >
                        <option value="phone">手机模式</option>
                        <option value="tv">电视模式</option>
                      </select>
                      <ChevronDown size={15} />
                    </div>
                  </label>
                </div>
                <div className="settings-actions">
                  <span>
                    <ShieldCheck size={14} />
                    设置仅保存在本机
                  </span>
                  <button
                    type="submit"
                    className="button primary"
                    disabled={disabled}
                  >
                    {busy === "settings" ? (
                      <LoaderCircle size={15} className="spin" />
                    ) : (
                      <Check size={16} />
                    )}
                    保存设置
                  </button>
                </div>
              </form>
              <aside className="settings-help">
                <div className="settings-help-title">
                  <Monitor size={19} />
                  <h3>准备好你的运行环境</h3>
                </div>
                <p>
                  支持 macOS（Apple Silicon / Intel）与
                  Windows。虚拟设备镜像架构需要与电脑匹配。
                </p>
                <ol>
                  <li>
                    安装 Android Studio，并安装 SDK Platform-Tools、Emulator 与
                    Build-Tools。
                  </li>
                  <li>在 Device Manager 创建手机设备和 Android TV 设备。</li>
                  <li>安装 scrcpy，配置路径并选择对应的虚拟设备。</li>
                </ol>
                <div className="help-note">
                  <CircleAlert size={15} />
                  <p>
                    APK 能否运行取决于其 Android 版本、CPU
                    架构和电视适配情况。同一模式共用一台虚拟设备，打开其他应用会切换该设备的显示窗口。更换设备后，如需卸载原设备中的应用，请先重新选择原设备。
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
                  runAction(
                    `${current.type}-${current.app.id}`,
                    () =>
                      current.type === "remove"
                        ? api!.removeApp(current.app.id)
                        : api!.uninstallApp(current.app.id, mode),
                    current.type === "remove"
                      ? "已从软件库移除应用"
                      : "应用已卸载",
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
