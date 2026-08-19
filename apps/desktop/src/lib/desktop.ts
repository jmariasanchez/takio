export type DesktopOpenOptions = {
  readonly title?: string;
  readonly directory?: boolean;
  readonly multiple?: boolean;
  readonly filters?: readonly {
    readonly name: string;
    readonly extensions: readonly string[];
  }[];
};

export type DesktopConfirmOptions = {
  readonly title?: string;
  readonly kind?: "info" | "warning" | "error";
  readonly okLabel?: string;
  readonly cancelLabel?: string;
};

type TakioDesktopBridge = {
  readonly invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  readonly openDialog: (options: DesktopOpenOptions) => Promise<string | string[] | null>;
  readonly confirm: (message: string, options?: DesktopConfirmOptions) => Promise<boolean>;
  readonly tempDirectory: () => Promise<string>;
  readonly joinPath: (...parts: string[]) => Promise<string>;
  readonly filePath: (file: File) => string;
  readonly onMenuAction: (listener: (action: string) => void) => () => void;
};

declare global {
  interface Window {
    readonly takio?: TakioDesktopBridge;
  }
}

function bridge(): TakioDesktopBridge {
  if (!window.takio) {
    throw new Error("Takio's desktop bridge is unavailable.");
  }
  return window.takio;
}

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return bridge().invoke<T>(command, args);
}

export function openDialog(options: DesktopOpenOptions): Promise<string | string[] | null> {
  return bridge().openDialog(options);
}

export function confirmDialog(message: string, options?: DesktopConfirmOptions): Promise<boolean> {
  return bridge().confirm(message, options);
}

export function tempDirectory(): Promise<string> {
  return bridge().tempDirectory();
}

export function joinPath(...parts: string[]): Promise<string> {
  return bridge().joinPath(...parts);
}

export function droppedFilePath(file: File): string {
  return bridge().filePath(file);
}

export function onMenuAction(listener: (action: string) => void): () => void {
  return bridge().onMenuAction(listener);
}

export function coverFileSource(path: string): string {
  return `takio-cover://local/${encodeURIComponent(path)}`;
}
