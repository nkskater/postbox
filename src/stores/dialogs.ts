"use client";
/** Open/close state for app-wide dialogs. */
import { create } from "zustand";

interface DialogState {
  scriptPackageEditor: { id: string | null; workspaceId: string } | null;
  openScriptPackage(value: DialogState["scriptPackageEditor"]): void;
  datasetEditor: { id: string | null; workspaceId: string } | null;
  openDataset(value: DialogState["datasetEditor"]): void;
  saveTabId: string | null;
  codeTabId: string | null;
  importOpen: boolean;
  exampleRequestId: string | null;
  openExamples(id: string | null): void;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  /** Tab waiting for "discard unsaved changes?" confirmation. */
  confirmCloseTabId: string | null;
  setConfirmCloseTabId(id: string | null): void;
  openSave(tabId: string | null): void;
  openCode(tabId: string | null): void;
  setImportOpen(o: boolean): void;
  setPaletteOpen(o: boolean): void;
  setShortcutsOpen(o: boolean): void;
}

export const useDialogs = create<DialogState>()((set) => ({
  scriptPackageEditor: null,
  openScriptPackage: (scriptPackageEditor) => set({ scriptPackageEditor }),
  datasetEditor: null,
  openDataset: (datasetEditor) => set({ datasetEditor }),
  saveTabId: null,
  codeTabId: null,
  importOpen: false,
  exampleRequestId: null,
  openExamples: (exampleRequestId) => set({ exampleRequestId }),
  paletteOpen: false,
  shortcutsOpen: false,
  confirmCloseTabId: null,
  setConfirmCloseTabId: (confirmCloseTabId) => set({ confirmCloseTabId }),
  openSave: (saveTabId) => set({ saveTabId }),
  openCode: (codeTabId) => set({ codeTabId }),
  setImportOpen: (importOpen) => set({ importOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
}));
