import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
  type MessageBoxOptions,
  type OpenDialogOptions,
} from "electron";

import { invokeEngine, libraryServiceClient } from "./engine";

protocol.registerSchemesAsPrivileged([
  { scheme: "takio-cover", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

let mainWindow: BrowserWindow | null = null;

function sendMenuAction(action: string) {
  mainWindow?.webContents.send("takio:menu-action", action);
}

function buildMenu(): Menu {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [{ role: "appMenu" as const }]
      : []),
    {
      label: "File",
      submenu: [
        { label: "Import...", accelerator: "CmdOrCtrl+Shift+I", click: () => sendMenuAction("import") },
        { label: "Open Selected", accelerator: "CmdOrCtrl+O", click: () => sendMenuAction("open-selected") },
        { label: "Send Selected", click: () => sendMenuAction("send-selected") },
        { label: "Eject Selected", accelerator: "CmdOrCtrl+E", click: () => sendMenuAction("eject-selected") },
        { type: "separator" },
        { role: "close" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" },
        { type: "separator" },
        { label: "Find", accelerator: "CmdOrCtrl+F", click: () => sendMenuAction("find") },
      ],
    },
    { role: "windowMenu" },
  ];
  return Menu.buildFromTemplate(template);
}

function libraryRoot(): string {
  const override = process.env.TAKIO_DATA_DIR;
  if (override) {
    return resolve(override);
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Takio");
  }
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Takio");
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "takio");
}

function isManagedCover(path: string): boolean {
  const normalized = normalize(path);
  const root = normalize(libraryRoot()) + sep;
  return (
    isAbsolute(normalized) &&
    normalized.startsWith(root) &&
    normalized.split(sep).includes("covers") &&
    /\.(?:gif|jpe?g|png|webp)$/i.test(normalized)
  );
}

function registerIpc() {
  ipcMain.handle("takio:invoke", (_event, command: unknown, args: unknown) =>
    typeof command === "string"
      ? invokeEngine(command, typeof args === "object" && args !== null ? args as Record<string, unknown> : undefined)
      : { ok: false, error: { code: "invalid-arguments" } },
  );
  ipcMain.handle("takio:open-dialog", async (_event, input: Record<string, unknown>) => {
    const properties: OpenDialogOptions["properties"] = [
      input.directory === true ? "openDirectory" : "openFile",
      ...(input.multiple === true ? ["multiSelections" as const] : []),
    ];
    const filters = Array.isArray(input.filters) ? input.filters as OpenDialogOptions["filters"] : undefined;
    const options: OpenDialogOptions = {
      properties,
      filters,
      title: typeof input.title === "string" ? input.title : undefined,
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled) return null;
    return input.multiple === true ? result.filePaths : result.filePaths[0] ?? null;
  });
  ipcMain.handle("takio:confirm", async (_event, message: unknown, options: Record<string, unknown> | undefined) => {
    if (typeof message !== "string") return false;
    const dialogOptions: MessageBoxOptions = {
      type: options?.kind === "warning" ? "warning" : "question",
      message,
      detail: typeof options?.title === "string" ? options.title : undefined,
      buttons: [
        typeof options?.okLabel === "string" ? options.okLabel : "Continue",
        typeof options?.cancelLabel === "string" ? options.cancelLabel : "Cancel",
      ],
      cancelId: 1,
      defaultId: 0,
      noLink: true,
    };
    const result = mainWindow
      ? await dialog.showMessageBox(mainWindow, dialogOptions)
      : await dialog.showMessageBox(dialogOptions);
    return result.response === 0;
  });
  ipcMain.handle("takio:temp-directory", () => app.getPath("temp"));
  ipcMain.handle("takio:join-path", (_event, parts: unknown) =>
    Array.isArray(parts) && parts.every((part) => typeof part === "string") ? join(...parts) : "",
  );
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    title: "Takio",
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: "#f2eee5",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 18, y: 18 },
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = process.env.VITE_DEV_SERVER_URL ?? pathToFileURL(join(app.getAppPath(), "dist", "index.html")).href;
    if (!url.startsWith(allowed)) event.preventDefault();
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    await mainWindow.loadFile(join(app.getAppPath(), "dist", "index.html"));
  }
}

app.whenReady().then(async () => {
  protocol.handle("takio-cover", (request) => {
    const path = decodeURIComponent(new URL(request.url).pathname.slice(1));
    return isManagedCover(path) && existsSync(path)
      ? net.fetch(pathToFileURL(path).href)
      : new Response("Not found", { status: 404 });
  });
  registerIpc();
  Menu.setApplicationMenu(buildMenu());
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  libraryServiceClient.close();
});
