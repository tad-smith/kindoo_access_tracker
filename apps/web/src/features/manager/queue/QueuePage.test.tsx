// Component tests for the Manager Queue page. Mocks every hook so the
// test exercises just the rendering shape. The queue is read-only — no
// action affordances — so the tests assert the sections, metadata, the
// read-only note, the duplicate chip, the focus deep-link, and the
// absence of any complete / reject buttons.

import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import type { AccessRequest } from '@kindoo/shared';
import { makeRequest } from '../../../../test/fixtures';

const usePendingMock = vi.fn();
const useSeatForMemberMock = vi.fn();
const navigateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('./hooks', () => ({
  usePendingRequests: () => usePendingMock(),
}));

vi.mock('../../requests/hooks', () => ({
  useSeatForMember: (canonical: string | null) => useSeatForMemberMock(canonical),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigateMock,
}));

// The scope-label hook subscribes to the wards collection; stub it so
// these render tests don't need a live Firestore. The resolver maps the
// fixture ward code to a name and passes everything else through.
vi.mock('../../../lib/scopeLabel', () => ({
  useScopeLabel: () => (scope: string) =>
    scope === 'stake' ? 'Stake' : scope === 'CO' ? 'Cottonwood' : scope,
}));

import { ManagerQueuePage } from './QueuePage';

const WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/stake-building-access-%E2%80%94-k/klkkpfdafbjebccodmgkogdklachelpb';

function liveResult<T>(data: T[] | undefined, isLoading = false) {
  return {
    data,
    error: null,
    status: isLoading ? 'pending' : 'success',
    isPending: isLoading,
    isLoading,
    isSuccess: !isLoading,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

function liveDocResult<T>(data: T | undefined) {
  return {
    data,
    error: null,
    status: 'success',
    isPending: false,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isFetching: false,
    fetchStatus: 'idle',
  };
}

// Seat subscription still in flight: `data` is undefined but the query
// is `pending`, NOT `success`. Used to assert the edit-missing-seat
// chip stays hidden during load (it must gate on `isSuccess`, not on
// `!data` — both states have `data === undefined`).
function loadingDocResult() {
  return {
    data: undefined,
    error: null,
    status: 'pending',
    isPending: true,
    isLoading: true,
    isSuccess: false,
    isError: false,
    isFetching: true,
    fetchStatus: 'fetching',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useSeatForMemberMock.mockReturnValue(liveDocResult(undefined));
  // jsdom does not implement scrollIntoView; stub on the prototype so
  // the focus-card effect does not throw. Using `Object.defineProperty`
  // sidesteps the readonly-element-prototype TS check; restoreAllMocks
  // in afterEach takes care of cleanup.
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<ManagerQueuePage />', () => {
  it('renders the page title as "Request Queue"', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    render(<ManagerQueuePage />);
    expect(screen.getByRole('heading', { name: /^Request Queue$/ })).toBeInTheDocument();
  });

  it('renders the empty-state copy when there are no pending requests', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    render(<ManagerQueuePage />);
    expect(screen.getByText(/no pending requests/i)).toBeInTheDocument();
  });

  it('wraps the page in the medium-width container (800px max)', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    const { container } = render(<ManagerQueuePage />);
    expect(container.querySelector('section.kd-page-medium')).not.toBeNull();
  });

  it('renders one display-only card per pending request — no action buttons', () => {
    const requests = [
      makeRequest({ request_id: 'r1', type: 'add_manual', scope: 'CO', member_email: 'a@x.com' }),
      makeRequest({
        request_id: 'r2',
        type: 'add_temp',
        scope: 'stake',
        member_email: 'b@x.com',
        member_canonical: 'b@x.com',
        start_date: '2026-05-01',
        end_date: '2026-05-08',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-card-r1')).toBeInTheDocument();
    expect(screen.getByTestId('queue-card-r2')).toBeInTheDocument();
    // Read-only: no complete / reject affordances anywhere.
    expect(screen.queryByTestId('queue-complete-r1')).toBeNull();
    expect(screen.queryByTestId('queue-reject-r1')).toBeNull();
    expect(screen.queryByTestId('queue-complete-r2')).toBeNull();
    expect(screen.queryByTestId('queue-reject-r2')).toBeNull();
  });

  it('renders the member on a "Give Access To" row via the shared name/email line', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'tad.e.smith@gmail.com',
        member_name: 'Test User',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    expect(within(card).getByText(/Give Access To:/)).toBeInTheDocument();
    // jsdom has no media queries, so both forms exist in the DOM: the bold
    // name, the desktop parens, the mobile `email:` label, and the email.
    const member = card.querySelector('.roster-card-member');
    expect(member?.querySelector('.roster-card-name')?.textContent).toBe('Test User');
    expect(member?.querySelector('.roster-card-email-label')?.textContent).toBe('email:');
    expect(member?.querySelector('.roster-email')?.textContent).toBe('tad.e.smith@gmail.com');
  });

  it('falls back to bare email (no name, no label) on the Give Access To row when member_name is empty (add)', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        member_name: '',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    expect(within(card).getByText(/Give Access To:/)).toBeInTheDocument();
    const member = card.querySelector('.roster-card-member');
    expect(member?.querySelector('.roster-card-name')).toBeNull();
    expect(member?.querySelector('.roster-card-email-label')).toBeNull();
    expect(member?.querySelector('.roster-email')?.textContent).toBe('a@x.com');
  });

  it('uses "Remove Access For:" — not "Give Access To:" — on remove requests', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'remove',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        member_name: 'Alice Example',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    expect(within(card).getByText(/Remove Access For:/)).toBeInTheDocument();
    expect(within(card).queryByText(/Give Access To:/)).toBeNull();
    expect(card.textContent).toMatch(/Remove Access For:\s*Alice Example/);
  });

  it('labels the reason field "Calling" on add/edit queue cards (not "Reason")', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'a@x.com',
        reason: 'Primary President',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    expect(within(card).getByText(/Calling:/)).toBeInTheDocument();
    expect(within(card).getByText(/Primary President/)).toBeInTheDocument();
    expect(within(card).queryByText(/^Reason:$/)).toBeNull();
    expect(within(card).queryByText(/Removal reason:/)).toBeNull();
  });

  it('labels the reason field "Removal reason:" on remove queue cards', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'remove',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        reason: 'moved out of ward',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    expect(within(card).getByText(/Removal reason:/)).toBeInTheDocument();
    expect(card.textContent).toMatch(/Removal reason:\s*moved out of ward/);
    expect(within(card).queryByText(/^Calling:$/)).toBeNull();
  });

  it('places the Submitted date on the top row, right-justified next to the badges', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'a@x.com',
        requested_at: {
          seconds: Math.floor(new Date('2026-04-20T14:30:00Z').getTime() / 1000),
          nanoseconds: 0,
          toDate: () => new Date('2026-04-20T14:30:00Z'),
          toMillis: () => new Date('2026-04-20T14:30:00Z').getTime(),
        },
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    const topRow = card.querySelector('.kd-queue-card-line1');
    expect(topRow).not.toBeNull();
    // Submitted lives inside the top row (was previously on the meta row).
    expect(topRow?.textContent).toMatch(/Submitted:/);
    // The right-justified slot still carries the marker class for layout.
    expect(card.querySelector('.kd-queue-card-submitted')).not.toBeNull();
  });

  it('shows the requester email on its own row (falls back to email-only until requester_name lands)', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'a@x.com',
        requester_email: 'bishop@example.com',
        requester_canonical: 'bishop@example.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    expect(within(card).getByText(/Requester:/)).toBeInTheDocument();
    expect(card.textContent).toMatch(/Requester:\s*bishop@example\.com/);
  });

  it('shows buildings on a dedicated card row as a comma-delimited list', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        building_names: ['CO Building', 'BR Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const row = screen.getByTestId('queue-buildings-r1');
    expect(row).toHaveTextContent(/^Buildings:\s*CO Building, BR Building$/);
  });

  it('omits the buildings row when building_names is empty', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'a@x.com',
        building_names: [],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-buildings-r1')).toBeNull();
  });

  it('renders only sections that contain at least one request', () => {
    // Two non-urgent add_manual requests with old requested_at land
    // in Outstanding; no urgent or far-future requests are seeded so
    // Urgent and Future should not render.
    const requests = [
      makeRequest({
        request_id: 'r-outstanding',
        type: 'add_manual',
        requested_at: {
          seconds: Math.floor(new Date('2026-04-20').getTime() / 1000),
          nanoseconds: 0,
          toDate: () => new Date('2026-04-20'),
          toMillis: () => new Date('2026-04-20').getTime(),
        },
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-section-outstanding')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-section-urgent')).toBeNull();
    expect(screen.queryByTestId('queue-section-future')).toBeNull();
  });

  it('appends the open-request count in parentheses to each section heading', () => {
    // 2 urgent, 3 outstanding (old non-urgent), 1 future (far-out add_temp).
    const farIso = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    })();
    const oldTs = {
      seconds: Math.floor(new Date('2026-04-20').getTime() / 1000),
      nanoseconds: 0,
      toDate: () => new Date('2026-04-20'),
      toMillis: () => new Date('2026-04-20').getTime(),
    };
    const requests = [
      makeRequest({ request_id: 'u1', type: 'add_manual', urgent: true, requested_at: oldTs }),
      makeRequest({ request_id: 'u2', type: 'add_manual', urgent: true, requested_at: oldTs }),
      makeRequest({ request_id: 'o1', type: 'add_manual', requested_at: oldTs }),
      makeRequest({ request_id: 'o2', type: 'add_manual', requested_at: oldTs }),
      makeRequest({ request_id: 'o3', type: 'add_manual', requested_at: oldTs }),
      makeRequest({
        request_id: 'f1',
        type: 'add_temp',
        start_date: farIso,
        end_date: farIso,
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const urgent = within(screen.getByTestId('queue-section-urgent')).getByRole('heading', {
      level: 2,
    });
    expect(urgent).toHaveTextContent('Urgent Requests (2)');
    const outstanding = within(screen.getByTestId('queue-section-outstanding')).getByRole(
      'heading',
      { level: 2 },
    );
    expect(outstanding).toHaveTextContent('Outstanding Requests (3)');
    const future = within(screen.getByTestId('queue-section-future')).getByRole('heading', {
      level: 2,
    });
    expect(future).toHaveTextContent('Future Requests (1)');
  });

  it('omits a section heading entirely when its open-request count is zero', () => {
    // Only an outstanding row — Urgent and Future headings must not
    // appear anywhere in the DOM.
    const requests = [
      makeRequest({
        request_id: 'o1',
        type: 'add_manual',
        requested_at: {
          seconds: Math.floor(new Date('2026-04-20').getTime() / 1000),
          nanoseconds: 0,
          toDate: () => new Date('2026-04-20'),
          toMillis: () => new Date('2026-04-20').getTime(),
        },
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.queryByText(/Urgent Requests \(/)).toBeNull();
    expect(screen.queryByText(/Future Requests \(/)).toBeNull();
    expect(
      within(screen.getByTestId('queue-section-outstanding')).getByRole('heading', { level: 2 }),
    ).toHaveTextContent('Outstanding Requests (1)');
  });

  it('decrements the section count when the underlying request list shrinks; hides the section at zero', () => {
    const oldTs = {
      seconds: Math.floor(new Date('2026-04-20').getTime() / 1000),
      nanoseconds: 0,
      toDate: () => new Date('2026-04-20'),
      toMillis: () => new Date('2026-04-20').getTime(),
    };
    const initial = [
      makeRequest({ request_id: 'o1', type: 'add_manual', requested_at: oldTs }),
      makeRequest({ request_id: 'o2', type: 'add_manual', requested_at: oldTs }),
    ];
    usePendingMock.mockReturnValue(liveResult(initial));
    const { rerender } = render(<ManagerQueuePage />);
    expect(
      within(screen.getByTestId('queue-section-outstanding')).getByRole('heading', { level: 2 }),
    ).toHaveTextContent('Outstanding Requests (2)');

    // Snapshot updates (e.g., one request completed in the extension): count goes to 1.
    usePendingMock.mockReturnValue(
      liveResult([makeRequest({ request_id: 'o1', type: 'add_manual', requested_at: oldTs })]),
    );
    rerender(<ManagerQueuePage />);
    expect(
      within(screen.getByTestId('queue-section-outstanding')).getByRole('heading', { level: 2 }),
    ).toHaveTextContent('Outstanding Requests (1)');

    // Last request resolves: section vanishes; page-level empty state appears.
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    rerender(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-section-outstanding')).toBeNull();
    expect(screen.getByText(/no pending requests/i)).toBeInTheDocument();
  });

  it('places urgent requests in the Urgent section with a red top-bar marker', () => {
    const requests = [
      makeRequest({
        request_id: 'r-urgent',
        type: 'add_manual',
        urgent: true,
      }),
      makeRequest({
        request_id: 'r-normal',
        type: 'add_manual',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const urgentSection = screen.getByTestId('queue-section-urgent');
    expect(within(urgentSection).getByTestId('queue-card-r-urgent')).toBeInTheDocument();
    const card = screen.getByTestId('queue-card-r-urgent');
    expect(card).toHaveClass('kd-card-urgent');
    expect(card).toHaveAttribute('data-urgent', 'true');
    // And the non-urgent card is NOT marked.
    const normal = screen.getByTestId('queue-card-r-normal');
    expect(normal).not.toHaveClass('kd-card-urgent');
  });

  it('puts add_temp requests with start_date > today+7 in the Future section', () => {
    const farIso = (() => {
      const d = new Date();
      d.setDate(d.getDate() + 30);
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      return `${yyyy}-${mm}-${dd}`;
    })();
    const requests = [
      makeRequest({
        request_id: 'r-far',
        type: 'add_temp',
        start_date: farIso,
        end_date: farIso,
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const future = screen.getByTestId('queue-section-future');
    expect(within(future).getByTestId('queue-card-r-far')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-section-outstanding')).toBeNull();
  });

  it('shows the blocking duplicate chip on an add card when the member already has a seat', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    useSeatForMemberMock.mockReturnValue(
      liveDocResult({
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'A',
        scope: 'GE',
        type: 'auto',
        callings: ['Bishop'],
        building_names: [],
        duplicate_grants: [],
        created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        last_modified_at: {
          seconds: 0,
          nanoseconds: 0,
          toDate: () => new Date(),
          toMillis: () => 0,
        },
        last_modified_by: { email: 'a@b.c', canonical: 'a@b.c' },
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      }),
    );
    render(<ManagerQueuePage />);
    // The blocking error chip is shown verbatim, with its danger badge + copy.
    const chip = screen.getByTestId('queue-duplicate-error-r1');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('role', 'alert');
    expect(chip).toHaveClass('kd-queue-card-error');
    expect(chip.textContent).toMatch(/already has a auto seat in GE/);
    // No action affordances regardless of the chip.
    expect(screen.queryByTestId('queue-complete-r1')).toBeNull();
    expect(screen.queryByTestId('queue-reject-r1')).toBeNull();
  });

  it('shows no duplicate chip on an add card when the member has no existing seat', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'add_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    // No seat for this member → no duplicate chip.
    useSeatForMemberMock.mockReturnValue(liveDocResult(undefined));
    render(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-duplicate-error-r1')).toBeNull();
  });

  it('shows no duplicate chip on an edit card even when the member already has a seat', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'edit_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        building_names: ['Maple Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    // An edit completion modifies the existing seat, so a pre-existing
    // seat is expected — not a duplicate. The chip must not appear.
    useSeatForMemberMock.mockReturnValue(
      liveDocResult({
        member_canonical: 'a@x.com',
        member_email: 'a@x.com',
        member_name: 'A',
        scope: 'stake',
        type: 'manual',
        callings: [],
        building_names: ['Maple Building'],
        duplicate_grants: [],
        created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
        last_modified_at: {
          seconds: 0,
          nanoseconds: 0,
          toDate: () => new Date(),
          toMillis: () => 0,
        },
        last_modified_by: { email: 'a@b.c', canonical: 'a@b.c' },
        lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      }),
    );
    render(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-duplicate-error-r1')).toBeNull();
  });
});

describe('<ManagerQueuePage /> — read-only note', () => {
  it('always renders the read-only note pointing managers to the Chrome extension', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    render(<ManagerQueuePage />);
    const note = screen.getByTestId('queue-readonly-note');
    expect(note).toBeInTheDocument();
    expect(note.textContent).toMatch(
      /can only be completed or rejected from the Chrome extension/i,
    );
  });

  it('renders the note even when the queue has pending requests', () => {
    usePendingMock.mockReturnValue(
      liveResult([makeRequest({ request_id: 'r1', type: 'add_manual' })]),
    );
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-readonly-note')).toBeInTheDocument();
  });

  it('links the note to the Chrome Web Store listing, opening in a new tab safely', () => {
    usePendingMock.mockReturnValue(liveResult([] as AccessRequest[]));
    render(<ManagerQueuePage />);
    const link = screen.getByTestId('queue-readonly-note-link');
    expect(link).toHaveAttribute('href', WEB_STORE_URL);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('<ManagerQueuePage /> edit request rendering', () => {
  it('labels an edit_auto card "Edit (auto)" and shows the proposed buildings with the "→" prefix', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'edit_auto',
        scope: 'CO',
        member_email: 'auto@x.com',
        member_canonical: 'auto@x.com',
        building_names: ['Maple Building', 'Cedar Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r1');
    expect(within(card).getByText('Edit (auto)')).toBeInTheDocument();
    const buildingsRow = screen.getByTestId('queue-buildings-r1');
    expect(buildingsRow.textContent).toMatch(/→ Buildings:/);
    expect(buildingsRow.textContent).toMatch(/Maple Building, Cedar Building/);
  });

  it('labels an edit_manual card "Edit (manual)" with the reason + buildings', () => {
    const requests = [
      makeRequest({
        request_id: 'r2',
        type: 'edit_manual',
        scope: 'CO',
        member_email: 'manual@x.com',
        member_canonical: 'manual@x.com',
        reason: 'Valiant Activities Leader',
        building_names: ['Maple Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r2');
    expect(within(card).getByText('Edit (manual)')).toBeInTheDocument();
    expect(within(card).getByText(/Valiant Activities Leader/)).toBeInTheDocument();
    expect(screen.getByTestId('queue-buildings-r2').textContent).toMatch(
      /→ Buildings:.*Maple Building/,
    );
  });

  it('labels an edit_temp card "Edit (temp)" and renders the date range alongside the proposed buildings', () => {
    const requests = [
      makeRequest({
        request_id: 'r3',
        type: 'edit_temp',
        scope: 'CO',
        member_email: 'temp@x.com',
        member_canonical: 'temp@x.com',
        reason: 'youth conference',
        building_names: ['Maple Building'],
        start_date: '2026-05-01',
        end_date: '2026-05-15',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const card = screen.getByTestId('queue-card-r3');
    expect(within(card).getByText('Edit (temp)')).toBeInTheDocument();
    expect(card.textContent).toMatch(/2026-05-01.*2026-05-15/);
    expect(screen.getByTestId('queue-buildings-r3').textContent).toMatch(
      /→ Buildings:.*Maple Building/,
    );
  });

  it('does not prefix the buildings row with "→" on non-edit (add/remove) cards', () => {
    const requests = [
      makeRequest({
        request_id: 'r-add',
        type: 'add_manual',
        scope: 'CO',
        building_names: ['Maple Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    const row = screen.getByTestId('queue-buildings-r-add');
    expect(row.textContent).not.toMatch(/→/);
    expect(row.textContent).toMatch(/^Buildings:/);
  });
});

describe('<ManagerQueuePage /> edit-missing-seat chip', () => {
  function editSeat(overrides: Record<string, unknown> = {}) {
    return {
      member_canonical: 'a@x.com',
      member_email: 'a@x.com',
      member_name: 'A',
      scope: 'stake',
      type: 'manual',
      callings: [],
      building_names: ['Maple Building'],
      duplicate_grants: [],
      created_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      last_modified_at: { seconds: 0, nanoseconds: 0, toDate: () => new Date(), toMillis: () => 0 },
      last_modified_by: { email: 'a@b.c', canonical: 'a@b.c' },
      lastActor: { email: 'a@b.c', canonical: 'a@b.c' },
      ...overrides,
    };
  }

  it('shows the edit-missing-seat chip on an edit_* card whose seat subscription resolves to no seat', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'edit_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        building_names: ['Maple Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    // Subscription resolved (isSuccess) with no doc → target seat gone.
    useSeatForMemberMock.mockReturnValue(liveDocResult(undefined));
    render(<ManagerQueuePage />);
    const chip = screen.getByTestId('queue-edit-missing-seat-r1');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('role', 'alert');
    expect(chip).toHaveClass('kd-queue-card-error');
    expect(chip.textContent).toMatch(/This request edits a seat that no longer exists\./);
    // No action affordances — the queue is read-only.
    expect(screen.queryByTestId('queue-complete-r1')).toBeNull();
    expect(screen.queryByTestId('queue-reject-r1')).toBeNull();
  });

  it('does not show the edit-missing-seat chip on an edit_* card whose seat still exists', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'edit_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        building_names: ['Maple Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    useSeatForMemberMock.mockReturnValue(liveDocResult(editSeat()));
    render(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-edit-missing-seat-r1')).toBeNull();
  });

  it('does not show the edit-missing-seat chip while the seat subscription is still loading', () => {
    const requests = [
      makeRequest({
        request_id: 'r1',
        type: 'edit_manual',
        scope: 'stake',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        building_names: ['Maple Building'],
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    // Loading: data is undefined but the subscription has NOT resolved.
    // Gating on `!data` alone would flash the chip here; gating on
    // `isSuccess` keeps it hidden until the seat actually resolves absent.
    useSeatForMemberMock.mockReturnValue(loadingDocResult());
    render(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-edit-missing-seat-r1')).toBeNull();
  });

  it('shows the edit-missing-seat chip for edit_auto and edit_temp types too', () => {
    const requests = [
      makeRequest({
        request_id: 'auto1',
        type: 'edit_auto',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
        building_names: ['Maple Building'],
      }),
      makeRequest({
        request_id: 'temp1',
        type: 'edit_temp',
        scope: 'CO',
        member_email: 'b@x.com',
        member_canonical: 'b@x.com',
        building_names: ['Maple Building'],
        start_date: '2026-05-01',
        end_date: '2026-05-15',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    useSeatForMemberMock.mockReturnValue(liveDocResult(undefined));
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-edit-missing-seat-auto1')).toBeInTheDocument();
    expect(screen.getByTestId('queue-edit-missing-seat-temp1')).toBeInTheDocument();
  });

  it('does not show the edit-missing-seat chip on add or remove cards with no seat', () => {
    const requests = [
      makeRequest({
        request_id: 'r-add',
        type: 'add_manual',
        scope: 'CO',
        member_email: 'a@x.com',
        member_canonical: 'a@x.com',
      }),
      makeRequest({
        request_id: 'r-remove',
        type: 'remove',
        scope: 'CO',
        member_email: 'b@x.com',
        member_canonical: 'b@x.com',
      }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    useSeatForMemberMock.mockReturnValue(liveDocResult(undefined));
    render(<ManagerQueuePage />);
    expect(screen.queryByTestId('queue-edit-missing-seat-r-add')).toBeNull();
    expect(screen.queryByTestId('queue-edit-missing-seat-r-remove')).toBeNull();
  });
});

describe('<ManagerQueuePage /> — ?focus=<rid> deep-link', () => {
  it('applies the is-focused class to the matching card', async () => {
    const requests = [
      makeRequest({ request_id: 'abc123', type: 'add_manual' }),
      makeRequest({ request_id: 'other', type: 'add_manual' }),
    ];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="abc123" />);
    await waitFor(() => {
      expect(screen.getByTestId('queue-card-abc123')).toHaveClass('is-focused');
    });
    expect(screen.getByTestId('queue-card-other')).not.toHaveClass('is-focused');
  });

  it('scrolls the matching card into view', async () => {
    const scrollIntoViewSpy = vi
      .spyOn(Element.prototype, 'scrollIntoView')
      .mockImplementation(() => {});
    const requests = [makeRequest({ request_id: 'abc123', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="abc123" />);
    await waitFor(() => {
      expect(scrollIntoViewSpy).toHaveBeenCalledWith({
        behavior: 'smooth',
        block: 'center',
      });
    });
  });

  it('strips the focus param from the URL after the effect runs', async () => {
    const requests = [makeRequest({ request_id: 'abc123', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="abc123" />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    const arg = navigateMock.mock.calls[0]?.[0] as {
      to: string;
      replace: boolean;
      search: (prev: Record<string, unknown>) => Record<string, unknown>;
    };
    expect(arg.to).toBe('/manager/queue');
    expect(arg.replace).toBe(true);
    // The search reducer should drop `focus` while preserving any
    // sibling params the URL might have carried.
    expect(arg.search({ focus: 'abc123', other: 'x' })).toEqual({
      focus: undefined,
      other: 'x',
    });
  });

  it('still strips the param when no request matches the focus value', async () => {
    const requests = [makeRequest({ request_id: 'r1', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage focus="missing" />);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalled();
    });
    // No card highlights; no error; the rendered card is untouched.
    expect(screen.getByTestId('queue-card-r1')).not.toHaveClass('is-focused');
  });

  it('does not highlight any card when focus is unset', () => {
    const requests = [makeRequest({ request_id: 'r1', type: 'add_manual' })];
    usePendingMock.mockReturnValue(liveResult(requests));
    render(<ManagerQueuePage />);
    expect(screen.getByTestId('queue-card-r1')).not.toHaveClass('is-focused');
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('removes the is-focused class after the highlight timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const requests = [makeRequest({ request_id: 'abc123', type: 'add_manual' })];
      usePendingMock.mockReturnValue(liveResult(requests));
      render(<ManagerQueuePage focus="abc123" />);
      // Flush queueMicrotask + the synchronous setFocusedId so the class lands.
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByTestId('queue-card-abc123')).toHaveClass('is-focused');
      // Advance past the highlight window.
      act(() => {
        vi.advanceTimersByTime(2500);
      });
      expect(screen.getByTestId('queue-card-abc123')).not.toHaveClass('is-focused');
    } finally {
      vi.useRealTimers();
    }
  });
});
