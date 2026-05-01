// Tests for the install-prompt capture hook. The browser-internal
// `BeforeInstallPromptEvent` isn't a constructable type, so we
// synthesise it via an `Event` plus the `prompt` / `userChoice`
// surface the hook reads.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useInstallPrompt } from './useInstallPrompt';

interface SyntheticPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

function makePromptEvent(outcome: 'accepted' | 'dismissed' = 'accepted'): SyntheticPromptEvent {
  const event = new Event('beforeinstallprompt') as SyntheticPromptEvent;
  event.prompt = vi.fn().mockResolvedValue(undefined);
  event.userChoice = Promise.resolve({ outcome, platform: 'web' });
  return event;
}

describe('useInstallPrompt', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('starts with canInstall=false until beforeinstallprompt fires', () => {
    const { result } = renderHook(() => useInstallPrompt());
    expect(result.current.canInstall).toBe(false);
  });

  it('flips canInstall=true when beforeinstallprompt fires', () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(makePromptEvent());
    });
    expect(result.current.canInstall).toBe(true);
  });

  it('reports unavailable when promptInstall called before the event fires', async () => {
    const { result } = renderHook(() => useInstallPrompt());
    const outcome = await result.current.promptInstall();
    expect(outcome).toBe('unavailable');
  });

  it('forwards prompt() and resolves with the userChoice outcome', async () => {
    const event = makePromptEvent('accepted');
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(event);
    });
    let outcome: string | undefined;
    await act(async () => {
      outcome = await result.current.promptInstall();
    });
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(outcome).toBe('accepted');
    // After resolution the deferred event is consumed — canInstall flips back.
    expect(result.current.canInstall).toBe(false);
  });

  it('clears the deferred prompt on appinstalled', () => {
    const { result } = renderHook(() => useInstallPrompt());
    act(() => {
      window.dispatchEvent(makePromptEvent());
    });
    expect(result.current.canInstall).toBe(true);
    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });
    expect(result.current.canInstall).toBe(false);
  });
});
