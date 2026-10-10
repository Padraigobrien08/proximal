"use client";

/** Tell mounted views (shell course list, home) that persisted data changed so they refetch. */
export const DATA_CHANGED = "proximal:data-changed";

export function notifyDataChanged() {
  window.dispatchEvent(new Event(DATA_CHANGED));
}

export const OPEN_IMPORT = "proximal:open-import";

/** Ask the shell to open its import dialog (e.g. from an empty state). */
export function openImportDialog() {
  window.dispatchEvent(new Event(OPEN_IMPORT));
}
