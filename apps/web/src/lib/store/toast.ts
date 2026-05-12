// Cross-page toast queue. Zustand store; consumed by `<Toast />` host
// (mounted once in `Shell.tsx`) and by any feature mutation that wants
// to surface a non-blocking notification.
//
// Kind vocabulary: 'info' | 'success' | 'warn' | 'error'.
// Auto-dismiss timeouts: 3.5s for info/success, 6.5s for warn/error.

import { create } from 'zustand';

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface ToastMessage {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastState {
  toasts: ToastMessage[];
  push: (message: string, kind?: ToastKind) => number;
  dismiss: (id: number) => void;
  clear: () => void;
}

let nextId = 1;

const DEFAULT_TTL_MS: Record<ToastKind, number> = {
  info: 3500,
  success: 3500,
  warn: 6500,
  error: 6500,
};

const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push(message, kind = 'info') {
    const id = nextId;
    nextId += 1;
    set((state) => ({ toasts: [...state.toasts, { id, kind, message }] }));
    const ttl = DEFAULT_TTL_MS[kind];
    const handle = setTimeout(() => {
      get().dismiss(id);
    }, ttl);
    timers.set(id, handle);
    return id;
  },
  dismiss(id) {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearTimeout(handle);
      timers.delete(id);
    }
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
  clear() {
    for (const handle of timers.values()) {
      clearTimeout(handle);
    }
    timers.clear();
    set({ toasts: [] });
  },
}));

/**
 * Imperative `toast(msg, kind)` for non-React call sites (e.g. inside a
 * mutation hook before the component mounts).
 */
export function toast(message: string, kind: ToastKind = 'info'): number {
  return useToastStore.getState().push(message, kind);
}
