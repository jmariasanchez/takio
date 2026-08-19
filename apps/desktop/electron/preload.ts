import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("takio", {
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("takio:invoke", command, args),
  openDialog: (options: Record<string, unknown>) =>
    ipcRenderer.invoke("takio:open-dialog", options),
  confirm: (message: string, options?: Record<string, unknown>) =>
    ipcRenderer.invoke("takio:confirm", message, options),
  tempDirectory: () => ipcRenderer.invoke("takio:temp-directory"),
  joinPath: (...parts: string[]) => ipcRenderer.invoke("takio:join-path", parts),
  filePath: (file: File) => webUtils.getPathForFile(file),
  onMenuAction: (listener: (action: string) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, action: string) => listener(action);
    ipcRenderer.on("takio:menu-action", handler);
    return () => ipcRenderer.removeListener("takio:menu-action", handler);
  },
});
