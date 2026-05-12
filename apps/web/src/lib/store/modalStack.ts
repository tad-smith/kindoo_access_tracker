// Cross-page modal stack. Tracks open modal IDs in order so any code
// path that needs to know "is anything modal open right now?" can
// query a single Zustand store instead of poking the DOM.
//
// The Dialog primitive in `components/ui/Dialog.tsx` calls `push()` on
// open and `pop()` on close. Deep-link handlers can query the top of
// the stack to suppress hotkeys when a modal owns the focus.

import { create } from 'zustand';

interface ModalStackState {
  /** Modal IDs in open order (oldest first, top of stack last). */
  open: string[];
  push: (id: string) => void;
  pop: (id: string) => void;
  topId: () => string | null;
  isOpen: (id?: string) => boolean;
}

export const useModalStackStore = create<ModalStackState>((set, get) => ({
  open: [],
  push(id) {
    set((state) => ({ open: [...state.open.filter((x) => x !== id), id] }));
  },
  pop(id) {
    set((state) => ({ open: state.open.filter((x) => x !== id) }));
  },
  topId() {
    const { open } = get();
    return open.length === 0 ? null : (open[open.length - 1] ?? null);
  },
  isOpen(id?: string) {
    const { open } = get();
    if (id === undefined) return open.length > 0;
    return open.includes(id);
  },
}));
