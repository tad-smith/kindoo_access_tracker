// Sectioned nav model. Pure derivation — given a `Principal`, returns
// the ordered list of nav sections (Quick Links, Rosters, Settings,
// Account) each containing the items visible to that principal.
// Sections with zero visible items are omitted entirely (header AND
// section both disappear) per `docs/navigation-redesign.md` §8.
//
// Items are a discriminated union:
//   - `kind: 'link'` — navigates to `to` on click. Renders as `<Link>`.
//   - `kind: 'action'` — runs a side-effect on click. Renders as
//     `<button>`. Used for Logout (Account section).
//
// The Ward Roster nav entry (§9) routes by role:
//   - Manager OR stake (with or without bishopric) → /stake/wards
//   - Bishopric only                                → /bishopric/roster

import type { LucideIcon } from 'lucide-react';
import {
  Bell,
  Building2,
  ClipboardList,
  Download,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LogOut,
  PlusCircle,
  ScrollText,
  Settings,
  Table,
  Users,
} from 'lucide-react';
import { STAKE_ID } from '../../lib/constants';
import type { Principal } from '../../lib/principal';

interface NavItemBase {
  /** Stable key for React lists + active-state lookups. */
  key: string;
  label: string;
  icon: LucideIcon;
}

export interface NavLinkItem extends NavItemBase {
  kind: 'link';
  to: string;
}

export interface NavActionItem extends NavItemBase {
  kind: 'action';
  /** Discriminator for the runtime side-effect to run on click. */
  action: 'sign-out';
}

export type NavItem = NavLinkItem | NavActionItem;

export interface NavSection {
  /** Stable key. Section header text doubles as the screen-reader label. */
  key: 'quick-links' | 'rosters' | 'settings' | 'account';
  label: string;
  items: NavItem[];
}

function isManager(p: Principal): boolean {
  return p.isPlatformSuperadmin || p.managerStakes.includes(STAKE_ID);
}

function isStake(p: Principal): boolean {
  return p.stakeMemberStakes.includes(STAKE_ID);
}

function isBishopric(p: Principal): boolean {
  const wards = p.bishopricWards[STAKE_ID];
  return Array.isArray(wards) && wards.length > 0;
}

/**
 * Resolve the Ward Roster nav target. Manager or stake users — even if
 * they're also bishopric — go to the all-wards picker. Bishopric-only
 * users go to their per-ward roster.
 */
export function wardRosterPathFor(principal: Principal): string {
  if (isManager(principal) || isStake(principal)) return '/stake/wards';
  return '/bishopric/roster';
}

/**
 * Build the nav sections visible to a principal. Empty sections (no
 * visible items) are omitted entirely.
 */
export function navSectionsForPrincipal(principal: Principal): NavSection[] {
  const manager = isManager(principal);
  const stake = isStake(principal);
  const bishopric = isBishopric(principal);
  const anyRole = manager || stake || bishopric;

  const quickLinks: NavItem[] = [];
  if (manager) {
    quickLinks.push({
      kind: 'link',
      key: 'dashboard',
      label: 'Dashboard',
      to: '/manager/dashboard',
      icon: LayoutDashboard,
    });
    quickLinks.push({
      kind: 'link',
      key: 'queue',
      label: 'Request Queue',
      to: '/manager/queue',
      icon: Inbox,
    });
  }
  if (bishopric || stake) {
    quickLinks.push({
      kind: 'link',
      key: 'new-request',
      label: 'New Request',
      to: '/new',
      icon: PlusCircle,
    });
  }
  if (anyRole) {
    quickLinks.push({
      kind: 'link',
      key: 'my-requests',
      label: 'My Requests',
      to: '/my-requests',
      icon: ClipboardList,
    });
  }

  const rosters: NavItem[] = [];
  if (manager || stake || bishopric) {
    rosters.push({
      kind: 'link',
      key: 'ward-roster',
      label: 'Ward Roster',
      to: wardRosterPathFor(principal),
      icon: Users,
    });
  }
  if (manager || stake) {
    rosters.push({
      kind: 'link',
      key: 'stake-roster',
      label: 'Stake Roster',
      to: '/stake/roster',
      icon: Building2,
    });
  }
  if (manager) {
    rosters.push({
      kind: 'link',
      key: 'all-seats',
      label: 'All Seats',
      to: '/manager/seats',
      icon: Table,
    });
  }

  const settings: NavItem[] = [];
  if (manager) {
    // Operator-specified order: Notifications, Configuration,
    // App Access, Import, Audit Log. Notifications leads because it
    // is the first per-user setting most operators reach for after
    // landing; Audit Log stays at the bottom as a less-frequent path.
    // Manager-only for-now on Notifications; future expansion to
    // bishopric/stake users is planned when push for
    // completed/rejected/cancelled requests ships.
    settings.push({
      kind: 'link',
      key: 'notifications',
      label: 'Notifications',
      to: '/notifications',
      icon: Bell,
    });
    settings.push({
      kind: 'link',
      key: 'configuration',
      label: 'Configuration',
      to: '/manager/configuration',
      icon: Settings,
    });
    settings.push({
      kind: 'link',
      key: 'access',
      label: 'App Access',
      to: '/manager/access',
      icon: KeyRound,
    });
    settings.push({
      kind: 'link',
      key: 'import',
      label: 'Import',
      to: '/manager/import',
      icon: Download,
    });
    settings.push({
      kind: 'link',
      key: 'audit',
      label: 'Audit Log',
      to: '/manager/audit',
      icon: ScrollText,
    });
  }

  // Account section: visible to every authorized user (anyone reaching
  // the nav at all). One item today (Logout); future-proofed for things
  // like Profile / Notification preferences.
  const account: NavItem[] = [];
  if (anyRole) {
    account.push({
      kind: 'action',
      key: 'logout',
      label: 'Logout',
      action: 'sign-out',
      icon: LogOut,
    });
  }

  const out: NavSection[] = [];
  if (quickLinks.length > 0) {
    out.push({ key: 'quick-links', label: 'Quick Links', items: quickLinks });
  }
  if (rosters.length > 0) {
    out.push({ key: 'rosters', label: 'Rosters', items: rosters });
  }
  if (settings.length > 0) {
    out.push({ key: 'settings', label: 'Settings', items: settings });
  }
  if (account.length > 0) {
    out.push({ key: 'account', label: 'Account', items: account });
  }
  return out;
}

/** Flatten a section list to its items in render order. */
export function flattenNavItems(sections: NavSection[]): NavItem[] {
  const out: NavItem[] = [];
  for (const s of sections) out.push(...s.items);
  return out;
}
