# Navigation redesign — left rail + sectioned nav

## 1. Status and scope

Design doc for the Firebase nav redesign. Implementation lands in Firebase migration **Phase 10.1** (operator-deferred at Phase 11 cutover).

Phase entry in [`firebase-migration.md`](firebase-migration.md#phase-101--navigation-redesign-left-rail--sectioned-nav). The Phase 4 layout shell + role-aware `Nav.tsx` that this redesign replaces lands first; the full nav-item set isn't complete until Phase 7.

## 2. Goals

The Chunk 10 responsive pass made the Apps Script app legible on phones, but the underlying nav stayed top-tab. With three roles overlaid (manager + bishopric + stake) a multi-role user can hold ten or more tabs, and at phone widths the tab strip wraps or horizontal-scrolls. The redesign:

- **Mobile.** Phone gets a hamburger drawer; tablet gets an icons-only rail; desktop gets a full rail.
- **Visual organization.** Nav items collapse cleanly into four sections — Quick Links, Rosters, Settings, Account — instead of one long list.
- **Persistent affordance.** A left rail keeps navigation visible while the user works, instead of competing with the page header.

## 3. Breakpoints

Tailwind cutoffs:

- **Phone:** < 640px
- **Tablet:** 640px ≤ width < 1024px
- **Desktop:** ≥ 1024px

Boundary rule: desktop wins at exactly 1024px. These align with Tailwind's `sm` and `lg` breakpoints. If the Firebase port adopts a different CSS framework, these numeric values stay constant; only the variable names change.

## 4. Brand bar

Fixed at the top of the viewport, always visible during scroll. Brand icon (left) plus stake name and signed-in user's email (right). Horizontal flex row; height fixed across breakpoints (typical 56–64px; implementation's call).

The brand bar **never** carries the logout button at any breakpoint. Logout lives inside the rail or drawer (§5, §6, §7).

Phone (<640px): hamburger button at far left, brand icon immediately to its right. The user email truncates or hides entirely; it remains accessible inside the drawer's Account section, displayed beneath Logout (§7, §15). Tablet (640–1023px): brand bar matches desktop — icon, stake name, email; no hamburger, no logout.

## 5. Desktop mode (≥1024px)

Below the brand bar, a persistent left rail fills the remaining viewport height. Rail width is implementation's call within a 240–280px envelope — wider than the tablet rail's 64px so labels breathe.

Each nav item renders a Lucide icon plus text label. Section headers — text labels, no icon — sit above their groups, with a horizontal separator above each except the first. Active item: 3–4px vertical bar on the left edge in the accent color plus a subtle background tint.

Logout lives in the Account section in the rail, like any other nav item (see §8). The version stamp remains at the bottom of the rail as small uninteractive text. Content fills the viewport to the right of the rail; max width is per-page.

**Logout location decision.** Logout is a regular nav item in the Account section, not a pinned footer button. The brand bar shows the user's email but no sign-out affordance, avoiding two logout buttons on screen and keeping the brand bar consistent across breakpoints.

## 6. Tablet mode (640–1023px)

Brand bar matches desktop. Left rail is visible but icons-only at rest, fixed 64px width; each nav item renders only the Lucide icon. Section headers can't render as text in 64px — they're replaced with a horizontal divider line plus a vertical gap matching the desktop section header's height. See §14 for why the gap is preserved.

Active item uses the same vertical-bar-plus-background treatment as desktop. Hovering an icon with a mouse surfaces a tooltip with the label.

**Rail-expansion-in-place.** The rail itself expands in place from 64px (icons-only) to ~248px (labeled), anchored to the left viewport edge (x=0). It floats over content; the page beneath does not reflow. The icons-only state and the labeled state are the same rail in two widths — there is no separate panel adjacent to the rail.

The expanded rail shares the icons rail's vertical position — top edge flush with the brand bar's bottom edge, height equal to viewport height minus the brand bar. Expand and collapse change only the rail's width (64px ↔ ~248px); there is **no vertical motion** on open or close. The brand bar stays visible in both states; the rail does not jump to viewport top when expanded.

**Interaction model.**

- **Tap an icon** → directly navigates to that page. No expansion.
- **Tap the rail in a non-icon area** → expands the rail in place. "Non-icon area" means anywhere on the rail that isn't a nav-item icon or an action icon: section dividers, gaps between icons, the foot region around the version stamp all expand the rail.
- **Drag the rail rightward** (touch or pointer) → expands the rail. Snap threshold is ~32px (half of icons-rail width); no partial states.
- **Hover an icon** (mouse) → tooltip with label.

Expanded rail dismissal: tap outside the rail, tap the same area that opened it, press Escape, or click a nav item to navigate. Selecting a nav item collapses the rail back to icons-only and swaps content.

Logout is no longer at the bottom of the icons rail or in an expanded rail's footer. It appears as the Account section's only item, like any other nav item, in both icons-only and expanded states (see §8). The version stamp remains at the bottom of the rail.

## 7. Phone mode (<640px)

Brand bar contains the hamburger (far left), brand icon, and stake name. User email and logout are not in the brand bar — the email moves into the drawer's Account section and logout is a regular nav item there.

No persistent rail; the entire viewport width below the brand bar belongs to content.

Tapping the hamburger slides a drawer in from the left. Drawer width is fixed (typical 280–320px; implementation's call) with a backdrop dim overlay behind it. Inside: the full nav with text labels and section headers, identical to the desktop rail. The Account section contains Logout (a regular nav item — see §8) and, immediately below Logout, the signed-in user's email rendered as informational, non-interactive text. The email appears here only on phone; tablet expanded rail and desktop rail do **not** show the email in the Account section because both breakpoints surface it in the brand bar (§4). The drawer footer carries only the version stamp.

Dismissal: tap a nav item, tap the backdrop, tap the hamburger again, swipe the drawer left, or press Escape. Selecting a nav item closes the drawer and swaps content in one motion.

## 8. Sectioned navigation

Four sections, in this order. Each item lists the role(s) it's visible for.

**Quick Links**

- Dashboard (Manager only)
- Request Queue (Manager only)
- New Request (bishopric or stake)
- My Requests (all authorized users)

**Rosters**

- Ward Roster (Manager, bishopric, or stake — see §9 for the routing logic)
- Stake Roster (Manager or stake)
- All Seats (Manager only)

**Settings**

- Notifications (Manager only for-now; future expansion to bishopric/stake users planned when Phase 9 ships push for completed/rejected/cancelled requests)
- Configuration (Manager only)
- App Access (Manager only)
- Import (Manager only)
- Audit Log (Manager only)

**Account**

- Logout (`log-out` icon, visible to all authorized users — i.e., anyone reaching the nav)

On phone only, the signed-in user's email is appended below Logout as informational, non-interactive text (see §7). Tablet and desktop show the email in the brand bar instead.

**Conditional section visibility.** If a user has access to zero items in a section, the section header AND the section entirely do not render. A bishopric-only user sees "Quick Links" (My Requests, New Request) and "Rosters" (Ward Roster); the "Settings" header doesn't appear. A stake-only user sees "Quick Links" + "Rosters" with no Settings. The Account section always renders because Logout is always visible.

## 9. Ward Roster routing logic

The single nav item labeled "Ward Roster" routes to one of two pages depending on the principal's roles:

- **Manager OR Stake** → "Ward Rosters" page. Any-ward picker; dropdown of all wards in the stake.
- **Bishopric only** (no Manager, no Stake) → "Ward Roster" page. Limited to the user's own ward. If bishopric in multiple wards, the picker is restricted to those wards.
- **Both Manager/Stake AND bishopric** → "Ward Rosters" page. The user's own ward is one option in the all-wards dropdown.

The nav label is always "Ward Roster" (singular). The label refers to the navigation entry, not the underlying page name. Both pages exist as separate URL paths in the Firebase port; URLs are defined in Phase 5 routing. Deep links from elsewhere (e.g. Dashboard's Recent Activity card) target the appropriate URL directly, not via this nav entry.

## 10. My Requests visibility

My Requests is always visible in Quick Links for all authorized users (i.e., users with at minimum one role; no-role users hit "not authorized" per [`spec.md`](spec.md) §4 and never reach the nav). The page shows an empty-state message if the user has never submitted a request. A server-side flag to hide the entry when empty was considered and rejected — computing it adds a read per page load to suppress one nav row that already handles the empty case gracefully.

## 11. Icons (Lucide library)

Implementation pulls icons from `lucide-react` (or `lucide` for vanilla TS) per Phase 5's chosen approach. Section headers do not have icons.

| Nav item | Lucide icon |
| --- | --- |
| Dashboard | `layout-dashboard` |
| Request Queue | `inbox` |
| New Request | `plus-circle` |
| My Requests | `clipboard-list` |
| Ward Roster | `users` |
| Stake Roster | `building-2` |
| All Seats | `table` |
| App Access | `key-round` |
| Import | `download` |
| Configuration | `settings` |
| Notifications | `bell` |
| Audit Log | `scroll-text` |
| Logout | `log-out` |

## 12. Active state styling

Across desktop and tablet:

- A 3–4px vertical bar on the left edge of the active item, in the accent color.
- A subtle background color change behind the entire item row.
- Icon and label color may shift toward the accent color or stay neutral — implementation's call.

Only one nav item is active at a time: the page currently displayed. On a sub-page reached via deep link (e.g. Audit Log filtered by entity), the active state reflects the current page, not the page that linked here.

## 13. Resize behavior across breakpoints

General rule: **crossing a breakpoint closes any open nav UI; resizing within a breakpoint maintains state.**

- Tablet → desktop with rail expanded: rail collapses (full desktop rail takes over).
- Tablet → phone with rail expanded: rail collapses.
- Phone → tablet with drawer open: drawer closes; icons-only rail visible. User can tap a non-icon area or drag to expand a fresh rail.
- Phone → desktop with drawer open: drawer closes; full rail visible.
- Resizing within tablet with rail expanded: expansion stays.
- Resizing within phone with drawer open: drawer stays.
- Resizing within desktop: rail always visible; no state to preserve.

Implementation note: detect breakpoint crossings via a `matchMedia` listener, not window resize handlers. `matchMedia` fires once per crossing.

## 14. Section header behavior on tablet

Section headers in the icons-only tablet rail are replaced with a horizontal divider line. The vertical space the section header text would have occupied at desktop sizing is preserved as a gap, so individual nav items sit at identical Y-coordinates regardless of breakpoint.

The point is muscle memory. The Dashboard icon sits at the same vertical position on tablet as the Dashboard label sits on desktop, so a user who's learned where Dashboard lives at desktop width can hit the same spot on tablet without re-orienting.

## 15. Brand bar sizing on phone

With hamburger + brand icon + stake name + (truncated or hidden) user email, the brand bar may need adjustments at very narrow widths (320–380px). Implementation choice: truncate stake name with ellipsis if needed; hide the user email entirely (it's accessible from the drawer's Account section per §7). Brand icon and stake name are the minimum visible elements at any phone width.

## 16. Implementation timing and dependencies

Not implemented in the Apps Script production app. Lands during Firebase migration Phase 10.1 — see [`firebase-migration.md`](firebase-migration.md#phase-101--navigation-redesign-left-rail--sectioned-nav). Phase 10.1 depends on Phase 4 (web SPA shell with topbar + Nav scaffolding) and Phase 7 (manager admin pages, which establish the full nav-item set). Implementation begins when the operator schedules the phase.

The first implementation of this design landed in PR #35 / branch `phase-10.1-navigation-redesign`. This design doc remains the canonical spec for any future re-implementation or refactor.
