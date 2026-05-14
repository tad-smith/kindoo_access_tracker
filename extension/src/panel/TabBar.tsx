// Underline tab strip for the tabbed shell. Three tabs:
//   1. Request Queue
//   2. Sync
//   3. Configure (gear icon, no label)
//
// Accessibility: tablist semantics — role="tablist", role="tab",
// aria-selected, aria-controls. Keyboard navigation: left/right arrows
// cycle through tabs (wrapping), Home/End jump to ends, Enter/Space
// activate the focused tab. Active panel container is rendered by
// TabbedShell with role="tabpanel".

import { useRef, type KeyboardEvent } from 'react';

export type TabKey = 'queue' | 'sync' | 'configure';

interface TabBarProps {
  active: TabKey;
  onChange: (key: TabKey) => void;
}

interface TabDef {
  key: TabKey;
  label: string;
  ariaLabel?: string;
  icon?: boolean;
  testId: string;
  panelId: string;
}

const TABS: TabDef[] = [
  {
    key: 'queue',
    label: 'Request Queue',
    testId: 'sba-tab-queue',
    panelId: 'sba-tabpanel-queue',
  },
  {
    key: 'sync',
    label: 'Sync',
    testId: 'sba-tab-sync',
    panelId: 'sba-tabpanel-sync',
  },
  {
    key: 'configure',
    label: '',
    ariaLabel: 'Configure',
    icon: true,
    testId: 'sba-tab-configure',
    panelId: 'sba-tabpanel-configure',
  },
];

export function TabBar({ active, onChange }: TabBarProps) {
  const tabRefs = useRef<Record<TabKey, HTMLButtonElement | null>>({
    queue: null,
    sync: null,
    configure: null,
  });

  function focusTab(key: TabKey) {
    const el = tabRefs.current[key];
    el?.focus();
    onChange(key);
  }

  function handleKey(e: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    const last = TABS.length - 1;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      const next = TABS[currentIndex === last ? 0 : currentIndex + 1]!;
      focusTab(next.key);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = TABS[currentIndex === 0 ? last : currentIndex - 1]!;
      focusTab(prev.key);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusTab(TABS[0]!.key);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusTab(TABS[last]!.key);
    }
    // Enter / Space fall through to the button's native click; no
    // extra handling needed since the button is already focused.
  }

  return (
    <div className="sba-tabbar" role="tablist" aria-label="Sections">
      {TABS.map((tab, i) => {
        const selected = tab.key === active;
        return (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el;
            }}
            type="button"
            role="tab"
            id={`sba-tab-${tab.key}`}
            aria-selected={selected}
            aria-controls={tab.panelId}
            aria-label={tab.ariaLabel}
            tabIndex={selected ? 0 : -1}
            className="sba-tab"
            onClick={() => onChange(tab.key)}
            onKeyDown={(e) => handleKey(e, i)}
            data-testid={tab.testId}
          >
            {tab.icon ? <GearIcon /> : tab.label}
          </button>
        );
      })}
    </div>
  );
}

function GearIcon() {
  // Inline 16x16 SVG, stroke-only, follows currentColor so active /
  // inactive tab color tracks the gear automatically.
  return (
    <span className="sba-tab-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </span>
  );
}
