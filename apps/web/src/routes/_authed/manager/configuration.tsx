// Manager Configuration route. CRUD over every editable table — config
// keys, managers, Kindoo sites, buildings, wards. Sub-tab is a search
// param `?tab=<key>` so deep-links land on the right section.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  ConfigurationPage,
  type ConfigTabKey,
} from '../../../features/manager/configuration/ConfigurationPage';
import { useRequireRole } from '../../../lib/useRequireRole';
import { LoadingSpinner } from '../../../lib/render/LoadingSpinner';

const tabSchema = z.enum([
  'config',
  'managers',
  'wards',
  'buildings',
  'kindoo-sites',
  'organizations',
]);

const searchSchema = z.object({
  tab: tabSchema.optional(),
  stake: z.string().optional(),
});

export const Route = createFileRoute('/_authed/manager/configuration')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: ConfigurationRoute,
});

function ConfigurationRoute() {
  // Platform superadmins get the whole page, not just the Kindoo Config
  // tab: they can already read every stake's parent doc, and the Home
  // Kindoo Site editor (spec §15) is superadmin-only, so a superadmin
  // who holds no role on the stake still needs to reach this route.
  // Sub-collection writes (Managers / Wards / Buildings / Organizations)
  // remain gated on `isManager` in `firestore.rules` — a superadmin
  // browsing those tabs sees them, and a write they aren't entitled to
  // fails at the rules layer.
  //
  // Reaching it needs an active stake, which a zero-role superadmin only
  // gets from a `?stake=X` deep link — `resolveActiveStake` treats the
  // URL tier permissively for them (`lib/activeStake.ts`), but no
  // storage tier and no tier-4 fallback does. The Stake List's per-row
  // Kindoo Config link is that entry point.
  const { ready, allowed } = useRequireRole(['manager', 'platformSuperadmin']);
  if (!ready) return <LoadingSpinner />;
  if (!allowed) return null;
  return <ConfigurationContent />;
}

function ConfigurationContent() {
  const { tab } = Route.useSearch();
  return <ConfigurationPage {...(tab !== undefined ? { initialTab: tab as ConfigTabKey } : {})} />;
}
