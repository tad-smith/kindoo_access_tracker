// Toast container. Mounted once at the Shell root; subscribes to the
// Zustand toast store and renders each open toast in a fixed-position
// stack. Mirrors the Apps Script `toast-host` block (see
// `src/ui/Styles.html`) so the visual is pixel-equivalent.
//
// Accessibility: each toast has `role="status"` and `aria-live="polite"`
// — screen readers announce the message as it arrives without
// interrupting the current focus.

import { useToastStore, type ToastKind } from '../../lib/store/toast';
import './Toast.css';

const KIND_CLASSES: Record<ToastKind, string> = {
  info: 'toast-info',
  success: 'toast-success',
  warn: 'toast-warn',
  error: 'toast-error',
};

export function ToastHost() {
  const toasts = useToastStore((state) => state.toasts);
  const dismiss = useToastStore((state) => state.dismiss);

  if (toasts.length === 0) return null;

  return (
    <div className="toast-host" aria-live="polite">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`toast ${KIND_CLASSES[toast.kind]}`}
          role="status"
          onClick={() => dismiss(toast.id)}
        >
          {toast.message}
        </div>
      ))}
    </div>
  );
}
