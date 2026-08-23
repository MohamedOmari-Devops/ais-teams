import { create } from "zustand";
import type { Agent, Channel, Message, Project } from "./lib/types";

/** A reply being streamed right now, keyed by runId. */
export interface Draft {
  runId: string;
  agentId: string;
  channelId: string;
  messageId: string;
  text: string;
  startedAt: number;
  contextTokens: number;
}

interface AppState {
  project: Project | null;
  channel: Channel | null;
  channels: Channel[];
  agents: Agent[];
  messages: Message[];
  drafts: Record<string, Draft>;
  hostCanRun: boolean;
  claudeVersion: string;

  setProject: (p: Project | null) => void;
  setChannel: (c: Channel | null) => void;
  setChannels: (c: Channel[]) => void;
  setAgents: (a: Agent[]) => void;
  setMessages: (m: Message[]) => void;
  upsertMessage: (m: Message) => void;
  removeMessage: (id: string) => void;
  setHost: (canRun: boolean, version: string) => void;

  startDraft: (d: Draft) => void;
  appendDraft: (runId: string, text: string) => void;
  endDraft: (runId: string) => void;
}

export const useApp = create<AppState>((set) => ({
  project: null,
  channel: null,
  channels: [],
  agents: [],
  messages: [],
  drafts: {},
  hostCanRun: false,
  claudeVersion: "",

  setProject: (project) => set({ project }),
  setChannel: (channel) => set({ channel }),
  setChannels: (channels) => set({ channels }),
  setAgents: (agents) => set({ agents }),
  setMessages: (messages) => set({ messages }),

  upsertMessage: (message) =>
    set((state) => {
      const idx = state.messages.findIndex((m) => m.id === message.id);
      if (idx === -1) return { messages: [...state.messages, message] };
      const next = state.messages.slice();
      next[idx] = message;
      return { messages: next };
    }),

  removeMessage: (id) =>
    set((state) => ({ messages: state.messages.filter((m) => m.id !== id) })),

  setHost: (hostCanRun, claudeVersion) => set({ hostCanRun, claudeVersion }),

  startDraft: (draft) =>
    set((state) => ({ drafts: { ...state.drafts, [draft.runId]: draft } })),

  appendDraft: (runId, text) =>
    set((state) => {
      const draft = state.drafts[runId];
      if (!draft) return {};
      return {
        drafts: {
          ...state.drafts,
          [runId]: { ...draft, text: draft.text + text },
        },
      };
    }),

  endDraft: (runId) =>
    set((state) => {
      const { [runId]: _gone, ...rest } = state.drafts;
      return { drafts: rest };
    }),
}));
