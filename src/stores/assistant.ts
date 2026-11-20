"use client";
/**
 * Assistant model settings shared by the sidebar assistant and every request-tab assistant. Kept in
 * memory only: credentials are never written to browser storage, and a reload clears them.
 */
import { create } from "zustand";
import type { AiMessage } from "@/core/ai/types";
import type { EditableField, EditableRequest } from "@/core/assistant/request-edit";

export type AssistantProvider = "strata" | "ollama" | "openai";

interface AssistantSettings {
  provider: AssistantProvider;
  server: string;
  model: string;
  token: string;
  /** Send secret values (credentials, secret variables) to the model; for local models. */
  includeSecrets: boolean;
  /** Include the last response in the request-tab assistant's context. */
  includeResponse: boolean;
  set(patch: Partial<Omit<AssistantSettings, "set">>): void;
}

export const useAssistantSettings = create<AssistantSettings>()((set) => ({
  provider: "strata",
  server: "",
  model: "",
  token: "",
  includeSecrets: false,
  includeResponse: true,
  set: (patch) => set(patch),
}));

export type ProposalStatus = "pending" | "applied" | "rejected" | "undone" | "failed";

export interface Proposal {
  /** The model's tool call id (answered with a tool message on the next turn). */
  callId: string;
  name: string;
  arguments: string;
  valid: boolean;
  /** The request's editable fields when the proposal was made, to detect later changes. */
  snapshot: EditableRequest;
  status: ProposalStatus;
  applied?: EditableField[];
  /** Field values before applying, for one-step undo. */
  undo?: Partial<EditableRequest>;
  note?: string;
}

export interface Conversation {
  open: boolean;
  /** Messages as sent to the model; user messages without the context block for display. */
  messages: AiMessage[];
  /** What the person typed, by message index, for display. */
  shown: Record<number, string>;
  proposals: Proposal[];
}

const EMPTY: Conversation = { open: false, messages: [], shown: {}, proposals: [] };

interface Conversations {
  byTab: Record<string, Conversation>;
  get(tabId: string): Conversation;
  update(tabId: string, change: (c: Conversation) => Conversation): void;
  /** Forget conversations of tabs that are no longer open. */
  prune(openTabIds: string[]): void;
}

export const useRequestAssistants = create<Conversations>()((set, get) => ({
  byTab: {},
  get: (tabId) => get().byTab[tabId] ?? EMPTY,
  update: (tabId, change) =>
    set((s) => ({ byTab: { ...s.byTab, [tabId]: change(s.byTab[tabId] ?? EMPTY) } })),
  prune: (open) =>
    set((s) => ({ byTab: Object.fromEntries(Object.entries(s.byTab).filter(([id]) => open.includes(id))) })),
}));
