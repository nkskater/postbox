"use client";
/** Open/close state for app-wide dialogs. */
import { create } from "zustand";

interface DialogState {
  saveTabId: string | null;
  codeTabId: string | null;
  importOpen: boolean;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  openSave(tabId: string | null): void;
  openCode(tabId: string | null): void;
  setImportOpen(o: boolean): void;
  setPaletteOpen(o: boolean): void;
  setShortcutsOpen(o: boolean): void;
}

export const useDialogs = create<DialogState>()((set) => ({
  saveTabId: null,
  codeTabId: null,
  importOpen: false,
  paletteOpen: false,
  shortcutsOpen: false,
  openSave: (saveTabId) => set({ saveTabId }),
  openCode: (codeTabId) => set({ codeTabId }),
  setImportOpen: (importOpen) => set({ importOpen }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
}));
