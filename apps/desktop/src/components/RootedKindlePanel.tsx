import { FORMAT_CATALOG, type FormatId, type LibraryItem } from "@takio/core";

import { confirmDialog } from "../lib/desktop";
import { sendRootedKindle, type RootedKindleSendRequest } from "../lib/destinations";

export type RootedKindlePanelDraft = {
  readonly enabled: boolean;
  readonly host: string;
  readonly user: string;
  readonly remoteRoot: string;
  readonly identityFile: string;
  readonly port: string;
  readonly timeoutMs: string;
  readonly format: string;
};

export type RootedKindlePanelProps = {
  readonly selectedItem: LibraryItem | null;
  readonly draft: RootedKindlePanelDraft;
  readonly pending: boolean;
  readonly onDraftChange: (draft: RootedKindlePanelDraft) => void;
  readonly onNotice: (kind: "status" | "error", text: string) => void;
};

const formatIds = new Set(FORMAT_CATALOG.map(({ id }) => id));
const safeText = /^[^\u0000-\u001f\u007f]+$/;

export function validateRootedKindleRequest(item: LibraryItem | null, draft: RootedKindlePanelDraft): RootedKindleSendRequest | null {
  if (!draft.enabled || !item || item.id.trim() === "") return null;
  const port = Number(draft.port);
  const timeoutMs = Number(draft.timeoutMs);
  const format = draft.format as FormatId;
  if (
    !formatIds.has(format) ||
    !item.formats.some((entry) => entry.format === format) ||
    ![draft.host, draft.user, draft.remoteRoot, draft.identityFile].every((value) => value.trim() !== "" && safeText.test(value)) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1_000 ||
    timeoutMs > 300_000
  ) {
    return null;
  }
  return {
    id: item.id,
    format,
    host: draft.host,
    user: draft.user,
    remoteRoot: draft.remoteRoot,
    identityFile: draft.identityFile,
    port,
    timeoutMs,
  };
}

export async function confirmAndSendRootedKindle(item: LibraryItem, request: RootedKindleSendRequest) {
  const confirmed = await confirmDialog(
    `Send ${item.title || item.id} to ${request.user}@${request.host}:${request.remoteRoot} over rooted Kindle SSH?`,
    {
      kind: "warning",
      title: "Rooted Kindle SSH uses strict host-key checking and never handles passwords or passphrases.",
      okLabel: "Send once",
      cancelLabel: "Cancel",
    },
  );
  return confirmed ? sendRootedKindle(request) : { ok: false as const, error: { code: "cancelled" } };
}

export function RootedKindlePanel({ selectedItem, draft, pending, onDraftChange, onNotice }: RootedKindlePanelProps) {
  const request = validateRootedKindleRequest(selectedItem, draft);
  const update = (patch: Partial<RootedKindlePanelDraft>) => onDraftChange({ ...draft, ...patch });

  return (
    <details className="rooted-kindle-panel">
      <summary>Advanced: rooted Kindle SSH/SCP</summary>
      <div className="rooted-kindle-panel__body">
        <label>
          <input type="checkbox" checked={draft.enabled} onChange={(event) => update({ enabled: event.currentTarget.checked })} />
          <span>Enable for this session only</span>
        </label>
        <p>No host configuration or secrets are saved. Passwords and passphrases are not supported.</p>
        <input aria-label="Kindle SSH host" placeholder="host" value={draft.host} onChange={(event) => update({ host: event.currentTarget.value })} />
        <input aria-label="Kindle SSH user" placeholder="user" value={draft.user} onChange={(event) => update({ user: event.currentTarget.value })} />
        <input aria-label="Remote directory" placeholder="/mnt/us/documents/koreader" value={draft.remoteRoot} onChange={(event) => update({ remoteRoot: event.currentTarget.value })} />
        <input aria-label="Private key path" placeholder="/absolute/path/to/key" value={draft.identityFile} onChange={(event) => update({ identityFile: event.currentTarget.value })} />
        <input aria-label="SSH port" placeholder="22" value={draft.port} onChange={(event) => update({ port: event.currentTarget.value })} />
        <input aria-label="Timeout milliseconds" placeholder="30000" value={draft.timeoutMs} onChange={(event) => update({ timeoutMs: event.currentTarget.value })} />
        <select aria-label="Library format" value={draft.format} onChange={(event) => update({ format: event.currentTarget.value })}>
          <option value="">Choose a present format…</option>
          {(selectedItem?.formats ?? []).map(({ format }) => <option key={format} value={format}>{format}</option>)}
        </select>
        <button
          disabled={pending || !request || !selectedItem}
          onClick={() => {
            if (!selectedItem || !request) return;
            void confirmAndSendRootedKindle(selectedItem, request).then((result) => {
              onNotice(result.ok ? "status" : "error", result.ok ? `Sent by SSH to ${result.value.path}` : `Rooted Kindle send failed: ${result.error.code}`);
            });
          }}
        >
          Send once over SSH
        </button>
      </div>
    </details>
  );
}
