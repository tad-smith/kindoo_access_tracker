// `/privacy` — Privacy policy for the Stake Building Access web app
// and the companion Chrome MV3 extension. Linked from the homepage
// footer and from the Chrome Web Store listing.
//
// Audience is a Chrome Web Store reviewer, not a casual visitor: the
// content is plain prose, the typography is utilitarian, and every
// claim about the extension matches what the manifest and source
// actually do. When the extension's manifest changes (permissions,
// host_permissions, new callables) update the relevant section here in
// the same commit.
//
// The route is reachable while signed out (no `_authed` gate). It does
// not depend on Firebase Auth or Firestore — it renders the same for
// reviewers, members, and signed-in managers alike.

import { createFileRoute, Link } from '@tanstack/react-router';
import { BrandIcon } from '../components/layout/BrandIcon';

export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
});

// Last-substantive-edit date. Bump whenever the policy text changes in
// a way a reviewer would care about; cosmetic refactors do not bump.
const LAST_UPDATED = '2026-05-16';

function PrivacyPage() {
  return (
    <div className="flex min-h-screen flex-col bg-[#f7f8fb] text-[color:var(--kd-fg-1)]">
      <header className="sticky top-0 z-20 border-b border-[color:var(--kd-chrome-border)] bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-3 px-5 py-3">
          <Link
            to="/"
            className="flex items-center gap-2.5 text-[color:var(--kd-primary)] no-underline hover:underline"
          >
            <BrandIcon size={28} />
            <span className="text-base font-semibold sm:text-[1.05rem]">Stake Building Access</span>
          </Link>
        </div>
      </header>

      <main className="flex-1">
        <article className="mx-auto w-full max-w-3xl px-5 py-10 sm:py-14">
          <h1 className="m-0 text-[1.6rem] font-semibold tracking-tight text-[color:var(--kd-fg-1)]">
            Privacy policy
          </h1>
          <p className="mt-2 text-sm text-[color:var(--kd-fg-3)]">Last updated: {LAST_UPDATED}</p>

          <Section title="1. Who we are">
            <p>
              Stake Building Access is a personal project operated by Tad Smith. It manages door
              access for stake-owned meetinghouses. Questions about this policy or about data we
              hold can be sent to{' '}
              <a
                href="mailto:support@stakebuildingaccess.org"
                className="text-[color:var(--kd-primary)] hover:underline"
              >
                support@stakebuildingaccess.org
              </a>
              .
            </p>
            <p>This policy covers two surfaces that share one backend:</p>
            <ul className="list-disc pl-6">
              <li>
                The Stake Building Access web app at{' '}
                <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                  stakebuildingaccess.org
                </code>
                , used by stake and ward leaders to request, approve, and track building access.
              </li>
              <li>
                The companion Chrome extension &ldquo;Stake Building Access — Kindoo Helper,&rdquo;
                used by a small number of designated Kindoo Managers in each stake to apply requests
                inside the Kindoo door-access portal.
              </li>
            </ul>
          </Section>

          <Section title="2. What the extension does">
            <p>
              The extension surfaces pending Stake Building Access requests in a slide-over panel on
              the Kindoo admin site. A Kindoo Manager works through the queue in the panel and
              applies each request to the corresponding seat in Kindoo. When the Kindoo-side work is
              finished, the extension marks the request complete in Stake Building Access.
            </p>
            <p>The extension activates only on two origins, both required for its core function:</p>
            <ul className="list-disc pl-6">
              <li>
                <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                  https://web.kindoo.tech/
                </code>{' '}
                — the Kindoo admin UI, where the slide-over panel is injected.
              </li>
              <li>
                <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                  https://service89.kindoo.tech/
                </code>{' '}
                — the Kindoo API host, used to read and write seat configuration on the
                manager&rsquo;s behalf.
              </li>
            </ul>
            <p>The extension does not run on any other site.</p>
          </Section>

          <Section title="3. Data we access and why">
            <p>
              The extension and web app handle the minimum data needed to route building-access
              requests to the right approver and to apply them to the door system.
            </p>
            <ul className="list-disc pl-6">
              <li>
                <strong>The signed-in user&rsquo;s Google account profile</strong> — email address,
                user id, and display name returned by Google OAuth. Used to authenticate the user to
                our backend and to record which leader approved or applied each request.
              </li>
              <li>
                <strong>Names and email addresses of church members</strong> for whom access is
                being requested. Submitted by the requesting leader; visible to other leaders whose
                approval is required and to the stake&rsquo;s Kindoo Manager.
              </li>
              <li>
                <strong>Building, door, and seat identifiers</strong> — which buildings a request
                covers, which doors a member should be able to open, and the corresponding records
                in Kindoo.
              </li>
              <li>
                <strong>Request metadata</strong> — request id, type (permanent, temporary, edit,
                removal), timestamps, approval state, and free-text notes the leader chooses to
                attach to a request or completion record.
              </li>
              <li>
                <strong>Kindoo session state on the manager&rsquo;s machine</strong> — the extension
                reads the Kindoo session token and active site id from the Kindoo admin site&rsquo;s
                own browser storage so it can call the Kindoo API on the manager&rsquo;s behalf.
                These values never leave the manager&rsquo;s device except as part of the
                manager&rsquo;s normal calls to Kindoo&rsquo;s own servers.
              </li>
            </ul>
            <p>
              We do not collect analytics, advertising identifiers, location, or browsing history.
              The extension does not read pages other than the two Kindoo origins listed above.
            </p>
          </Section>

          <Section title="4. Where data is stored and who can see it">
            <p>
              Stake Building Access data is stored in Google Cloud Firestore in a project we
              operate; the backend code runs as Google Cloud Functions in the United States region.
              Google Cloud is our infrastructure provider; aside from that processing relationship,
              we do not sell, rent, or share data with third parties.
            </p>
            <p>
              Within a stake, request data is visible to the leaders whose approval is required for
              that request and to the stake&rsquo;s designated Kindoo Manager. Audit records of who
              did what are retained for accountability purposes, consistent with the retention
              behaviour described in our public specification.
            </p>
          </Section>

          <Section title="5. Authentication">
            <p>
              The web app uses Google Sign-In. The Chrome extension uses Chrome&rsquo;s built-in
              identity API (
              <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                chrome.identity
              </code>
              ) to request a Google OAuth access token, which it exchanges for a Firebase session.
              The extension only ever acts on behalf of the signed-in Kindoo Manager and only with
              the OAuth scopes{' '}
              <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                openid
              </code>
              ,{' '}
              <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                email
              </code>
              , and{' '}
              <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                profile
              </code>
              .
            </p>
          </Section>

          <Section title="6. Chrome permissions">
            <p>The extension requests the following Chrome MV3 permissions:</p>
            <ul className="list-disc pl-6">
              <li>
                <strong>
                  <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                    identity
                  </code>
                </strong>{' '}
                — to obtain a Google OAuth access token through Chrome&rsquo;s account picker, so
                the user can sign in without re-typing a password.
              </li>
              <li>
                <strong>
                  <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                    identity.email
                  </code>
                </strong>{' '}
                — so the signed-in account&rsquo;s email is included in the OAuth response and we
                can match it to the leader&rsquo;s record in Stake Building Access.
              </li>
              <li>
                <strong>
                  <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                    storage
                  </code>
                </strong>{' '}
                — to persist a slim copy of the signed-in user&rsquo;s id and email plus the
                slide-over panel&rsquo;s open/closed state across browser restarts.
              </li>
              <li>
                <strong>
                  Host access to{' '}
                  <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                    https://web.kindoo.tech/
                  </code>
                </strong>{' '}
                — to inject the slide-over panel into the Kindoo admin UI where the manager works.
              </li>
              <li>
                <strong>
                  Host access to{' '}
                  <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                    https://service89.kindoo.tech/
                  </code>
                </strong>{' '}
                — to call the Kindoo API directly when applying a request to a seat.
              </li>
            </ul>
          </Section>

          <Section title="7. Your rights and how to contact us">
            <p>
              To correct, restrict, or delete data Stake Building Access holds about you, contact us
              at{' '}
              <a
                href="mailto:support@stakebuildingaccess.org"
                className="text-[color:var(--kd-primary)] hover:underline"
              >
                support@stakebuildingaccess.org
              </a>
              .
            </p>
            <p>
              You can stop the Chrome extension from accessing your account at any time by
              uninstalling it from{' '}
              <code className="rounded bg-[color:var(--kd-border-soft)] px-1.5 py-0.5 text-[0.9em]">
                chrome://extensions
              </code>{' '}
              and/or signing out from the web app. Revoking the OAuth grant in your Google
              account&rsquo;s security settings has the same effect.
            </p>
          </Section>

          <Section title="8. Changes to this policy">
            <p>
              We will update this page when our practices change. The &ldquo;last updated&rdquo;
              date above reflects the most recent substantive change.
            </p>
          </Section>
        </article>
      </main>

      <footer className="border-t border-[color:var(--kd-chrome-border)] bg-white">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-center px-5 py-5 text-sm text-[color:var(--kd-chrome-fg-muted)]">
          <Link to="/" className="text-[color:var(--kd-primary)] hover:underline">
            Back to home
          </Link>
        </div>
      </footer>
    </div>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

function Section({ title, children }: SectionProps) {
  return (
    <section className="mt-9">
      <h2 className="m-0 text-[1.1rem] font-semibold text-[color:var(--kd-fg-1)]">{title}</h2>
      <div className="mt-3 flex flex-col gap-3 text-[0.97rem] leading-relaxed text-[color:var(--kd-fg-2)]">
        {children}
      </div>
    </section>
  );
}
