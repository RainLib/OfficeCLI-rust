const { app, BrowserWindow, dialog, session } = require("electron");
const { fork } = require("node:child_process");
const { mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");

app.setName("Foldly Desktop");
const profile = resolve(app.commandLine.getSwitchValue("user-data-dir") || app.getPath("userData"));
mkdirSync(profile, { recursive: true, mode: 0o700 });
app.setPath("userData", profile);
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");

let window, workspace, origin, starting, quitting = false, saved = false;

function waitForWorkspace(check, timeout, request) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (error, result) => {
      clearTimeout(timer);
      workspace.off("message", message);
      workspace.off("exit", exit);
      workspace.off("error", finish);
      if (error) reject(error);
      else resolve(result);
    };
    const message = value => {
      if (value?.type === "save-error") finish(Error(value.error));
      else if (check(value)) finish(null, value);
    };
    const exit = (code, signal) => {
      if (request && code === 0) finish(null);
      else finish(Error(`本地工作区已退出（${signal || code}）。`));
    };
    workspace.on("message", message);
    workspace.once("exit", exit);
    workspace.once("error", finish);
    timer = setTimeout(() => finish(Error("等待本地工作区响应超时。")), timeout);
    if (workspace.exitCode !== null || workspace.signalCode !== null)
      exit(workspace.exitCode, workspace.signalCode);
    else if (request) workspace.send(request, error => { if (error && workspace.connected) finish(error); });
  });
}

async function start() {
  const kit = join(process.resourcesPath, "workspace");
  const root = join(profile, "workspace");
  workspace = fork(join(kit, "app", "cli.mjs"), ["desktop", "--root", root], {
    execPath: join(kit, "runtime", "node"),
    execArgv: [],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: process.env.LANG || "en_US.UTF-8" },
  });
  workspace.on("error", error => console.error(error.message));
  const ready = await waitForWorkspace(message => message?.type === "ready", 125_000);
  origin = new URL(ready.url).origin;
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin)) throw Error("本地工作区地址无效。");
  workspace.once("exit", (code) => {
    if (!quitting && code !== 0) {
      dialog.showErrorBox("折页", "本地编辑服务已退出。请重新启动折页恢复工作空间。");
      app.exit(1);
    }
  });
  if (quitting) return;
  const browserSession = session.fromPartition("persist:foldly-local");
  const websocketOrigin = origin.replace("http:", "ws:");
  browserSession.webRequest.onBeforeRequest(({ url }, done) => {
    const target = new URL(url);
    done({ cancel: !([origin, websocketOrigin].includes(target.origin) ||
      ["about:", "data:"].includes(target.protocol)) });
  });
  browserSession.setPermissionRequestHandler((_contents, permission, done, details) =>
    done(permission === "clipboard-sanitized-write" && new URL(details.requestingUrl || "about:blank").origin === origin));
  await browserSession.cookies.set({ url: origin, ...ready.cookie, path: "/", httpOnly: true, sameSite: "strict" });
  window = new BrowserWindow({
    title: "折页", width: 1400, height: 940, minWidth: 760, minHeight: 520, show: false,
    webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.on("close", (event) => {
    if (saved) return;
    event.preventDefault();
    app.quit();
  });
  window.once("ready-to-show", () => window.show());
  await window.loadURL(origin + "/workbench/");
}

async function saveAndQuit() {
  try {
    await starting;
    if (window?.webContents.getURL().startsWith(origin + "/")) {
      await window.webContents.executeJavaScript(`
        (async () => {
          document.documentElement.inert = true;
          await globalThis.foldlyPrepareToQuit?.();
        })()
      `);
    }
    if (workspace?.connected) {
      await waitForWorkspace(() => false, 125_000, { type: "save-and-stop" });
    } else if (workspace?.exitCode !== 0) {
      throw Error("本地编辑服务无法确认保存。");
    }
    saved = true;
    app.quit();
  } catch (error) {
    if (window && !window.isDestroyed())
      await window.webContents.executeJavaScript("document.documentElement.inert = false").catch(() => {});
    quitting = false;
    dialog.showErrorBox("无法保存工作空间", error.message + "\n请核对打开的文件，然后再次退出。");
  }
}

if (app.requestSingleInstanceLock()) {
  app.on("second-instance", () => { if (window) { window.show(); window.focus(); } });
  app.on("before-quit", (event) => {
    if (saved) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void saveAndQuit();
  });
  process.once("SIGTERM", () => app.quit());
  starting = app.whenReady().then(start);
  starting.catch(error => {
    if (workspace?.connected) workspace.disconnect();
    dialog.showErrorBox("无法启动折页", error.message);
    app.exit(1);
  });
} else {
  app.exit(0);
}
