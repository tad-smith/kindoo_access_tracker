// Stake Roster route. Thin wrapper.

import { createFileRoute } from '@tanstack/react-router';
import { StakeRosterPage } from '../../../features/stake/RosterPage';

export const Route = createFileRoute('/_authed/stake/roster')({
  component: StakeRosterPage,
});
