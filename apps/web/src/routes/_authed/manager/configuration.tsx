// Manager Configuration route. Phase 7 ships CRUD over every editable
// table — wards, buildings, managers, ward + stake calling templates,
// stake-doc config keys, and a triggers placeholder. Sub-tab is a
// search param `?tab=<key>` so deep-links land on the right section.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  ConfigurationPage,
  type ConfigTabKey,
} from '../../../features/manager/configuration/ConfigurationPage';

const tabSchema = z.enum([
  'wards',
  'buildings',
  'managers',
  'ward-callings',
  'stake-callings',
  'config',
  'triggers',
]);

const searchSchema = z.object({
  tab: tabSchema.optional(),
});

export const Route = createFileRoute('/_authed/manager/configuration')({
  validateSearch: (raw) => searchSchema.parse(raw),
  component: ConfigurationRoute,
});

function ConfigurationRoute() {
  const { tab } = Route.useSearch();
  return <ConfigurationPage {...(tab !== undefined ? { initialTab: tab as ConfigTabKey } : {})} />;
}
