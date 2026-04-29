// Manager Import route. Phase 7 wires the UI; Phase 8 wires the
// `runImportNow` callable.

import { createFileRoute } from '@tanstack/react-router';
import { ImportPage } from '../../../features/manager/import/ImportPage';

export const Route = createFileRoute('/_authed/manager/import')({
  component: ImportPage,
});
