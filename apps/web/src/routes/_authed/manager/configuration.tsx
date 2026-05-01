// Manager Configuration route. CRUD over every editable table — config
// keys, managers, wards, buildings, ward + stake calling templates.
// Sub-tab is a search param `?tab=<key>` so deep-links land on the
// right section.

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  ConfigurationPage,
  type ConfigTabKey,
} from '../../../features/manager/configuration/ConfigurationPage';

const tabSchema = z.enum([
  'config',
  'managers',
  'wards',
  'buildings',
  'ward-callings',
  'stake-callings',
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
