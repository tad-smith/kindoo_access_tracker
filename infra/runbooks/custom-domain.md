# Runbook: Firebase Hosting custom-domain setup

Operator playbook for pointing the `stakebuildingaccess.org` domain (chosen 2026-04-27 per F17 in `docs/firebase-migration.md`) at the Firebase Hosting projects.

Two surfaces, two flows in this runbook — same Firebase procedure, different DNS scopes:

1. **`staging.stakebuildingaccess.org` → `kindoo-staging`** — done first, gets the staging SPA reachable on a real domain for UAT.
2. **`stakebuildingaccess.org` (apex) → `kindoo-prod`** — done at Phase 11 cutover; this is the procedure that fulfills the "DNS flip" sub-task in `docs/firebase-migration.md` Phase 11.

> **Audience:** the operator (Tad). You'll work between the Firebase console, your domain registrar's DNS panel, and a terminal for verification commands. No code or repo changes are involved.

> **Prereqs:**
>
> - The two Firebase projects already exist (per `infra/runbooks/provision-firebase-projects.md` B1).
> - The registrar account that owns `stakebuildingaccess.org` is signed in and ready.
> - The `mail.stakebuildingaccess.org` records (Resend's DKIM CNAME + DMARC TXT, verified 2026-05-02 per T-04) are already in place. **Leave them alone throughout this runbook.** They live on a different host (`mail.`) and are independent of Hosting per the F17 apex/subdomain split.

> **What this runbook does NOT cover:** the Resend mail-subdomain DNS records — see `infra/runbooks/resend-api-key-setup.md` for the API-key side and the historical T-04 notes for the DKIM/DMARC records themselves.

---

## Section 1 — Staging subdomain (`staging.stakebuildingaccess.org` → `kindoo-staging`)

This is the first walkthrough. Do it end-to-end, verify it works, then save the procedure as muscle memory for Section 2.

### 1.1 Add the custom domain in the Firebase console

1. Open <https://console.firebase.google.com/project/kindoo-staging/hosting/main>.
2. Click "Add custom domain."
3. Enter `staging.stakebuildingaccess.org`.
4. **Do NOT check "Redirect requests to."** This is a primary-serving subdomain, not a redirect.
5. Click "Continue."

Firebase advances to the ownership-verification step.

### 1.2 Ownership verification (TXT record)

Firebase displays a `TXT` record, typically of the form `firebase-hosting-site-verification=<long-token>`. Firebase tells you whether to add it on the `staging` host or the apex — read the on-screen instruction; don't assume.

1. Open your registrar's DNS panel for `stakebuildingaccess.org`.
2. Add a new `TXT` record with the host and value Firebase displays, exactly. Default TTL is fine.
3. Save the record at the registrar.
4. Back in the Firebase console, click "Verify."

Verification typically propagates in minutes. If the console still shows "Pending" after ~10 min, give it longer — registrar-side TXT propagation occasionally takes hours. You can watch propagation independently with:

```bash
dig TXT <host-Firebase-told-you-to-use> +short
```

Expected: a line containing the verification token Firebase showed you. If empty, the record hasn't propagated yet.

### 1.3 Add the go-live A records

Once verification clears, Firebase displays two `A` records (Google IPs).

1. Back at your registrar's DNS panel, on the `staging` host, add **both** A records Firebase showed you. Default TTL.
2. Do **not** touch any apex (`@`) record.
3. Do **not** touch the `mail.` records (Resend DKIM CNAME + DMARC TXT — these are independent and must stay intact per F17).
4. Save at the registrar.

### 1.4 SSL provisioning

Firebase auto-provisions a Let's Encrypt certificate once the A records resolve. Timing: typically 15 min, occasionally up to 24h. The Firebase console shows the domain status as `Pending Setup` → `Needs Setup` → `Connected` as it works through verification + cert issuance.

No action required on your side — wait for `Connected`.

### 1.5 Add the domain to Firebase Auth's authorized list

Without this step, Google sign-in popups on the new domain fail with `auth/unauthorized-domain` even after the cert is live.

1. Open <https://console.firebase.google.com/project/kindoo-staging/authentication/settings>.
2. Click "Authorized domains."
3. Click "Add domain."
4. Enter `staging.stakebuildingaccess.org`.
5. Save.

### 1.6 Verify

Run each check; every one should match its expected output before declaring this section done.

```bash
dig staging.stakebuildingaccess.org +short
```

Expected: the two Firebase Hosting A record IPs you added in step 1.3.

```bash
curl -I https://staging.stakebuildingaccess.org
```

Expected: `HTTP/2 200` (or `HTTP/2 304`); a `server: Google Frontend` header; no cert warnings.

Then in a browser:

1. Open <https://staging.stakebuildingaccess.org>. Expected: the staging SPA loads with a valid certificate (no browser warning).
2. Sign in with Google. Expected: the popup completes; you land in the app authenticated. No `auth/unauthorized-domain` error in the browser console.

If sign-in fails specifically with `auth/unauthorized-domain`, step 1.5 didn't take — re-check the authorized-domains list and confirm `staging.stakebuildingaccess.org` appears there.

---

## Section 2 — Production apex (`stakebuildingaccess.org` → `kindoo-prod`) — Phase 11 cutover

Same Firebase procedure as Section 1, but DNS-side this lands on the apex (`@`), which has more constraints. Do this during the Phase 11 cutover window — not before, since live users land here once the records flip.

### 2.1 Add the custom domain in the Firebase console

1. Open <https://console.firebase.google.com/project/kindoo-prod/hosting/main>.
2. Click "Add custom domain."
3. Enter `stakebuildingaccess.org` (the apex; no subdomain).
4. **Do NOT check "Redirect requests to."**
5. Click "Continue."

Optionally also repeat the flow for `www.stakebuildingaccess.org` and configure that one **as a redirect to the apex** so users typing `www.` reach the same place. This is a separate "Add custom domain" entry; check the redirect box for the `www` entry only.

### 2.2 Ownership verification (TXT record)

Same as Section 1.2. Firebase displays a `TXT` record and tells you exactly which host to put it on. Add it at the registrar; click Verify in the console; wait for propagation.

If you already verified ownership for the staging subdomain in Section 1, Firebase may auto-recognise the parent domain as verified and skip this step. Trust the console.

### 2.3 Go-live A records on the apex

Apex DNS is more constrained than subdomain DNS — most registrars only allow one set of address records per host, so any pre-existing apex `A` / `AAAA` / `ALIAS` / `ANAME` record must be removed before adding Firebase's.

At the registrar's DNS panel:

1. **Delete any existing `A`, `AAAA`, `ALIAS`, or `ANAME` records on the apex (`@`).** If the registrar has a parking page, a default landing page, or a previous host's records on the apex, those go now.
2. Add **both** Firebase A records on `@`. Default TTL.
3. Leave the `mail.` records alone (Resend DKIM CNAME + DMARC TXT — independent, must stay).
4. Leave the `staging.` records alone (UAT continues to point at `kindoo-staging` after cutover; staging doesn't decommission).
5. If you set up the optional `www.` redirect entry in step 2.1, also add the Firebase records Firebase displays for `www.` (typically a `CNAME` to the Firebase Hosting CNAME target — read what the console shows).
6. Save at the registrar.

### 2.4 SSL provisioning

Same as Section 1.4. Firebase auto-provisions a Let's Encrypt certificate; wait for `Connected` in the console. 15 min to ~24h.

### 2.5 Add the domain to Firebase Auth's authorized list

The `kindoo-prod` Firebase project has its own separate authorized-domains list — the entry you added in Section 1.5 lives on the staging project and does NOT apply here.

1. Open <https://console.firebase.google.com/project/kindoo-prod/authentication/settings>.
2. Click "Authorized domains."
3. Click "Add domain." Enter `stakebuildingaccess.org`. Save.
4. If you set up the `www.` redirect in 2.1, also add `www.stakebuildingaccess.org`.

### 2.6 Verify

```bash
dig stakebuildingaccess.org +short
```

Expected: the two Firebase Hosting A record IPs from step 2.3. **Should NOT include** any IP from a previous host.

```bash
curl -I https://stakebuildingaccess.org
```

Expected: `HTTP/2 200`; `server: Google Frontend`; no cert warnings.

Then in a browser:

1. Open <https://stakebuildingaccess.org>. Expected: the prod SPA loads with a valid cert.
2. Sign in with Google. Expected: completes cleanly.
3. (If you set up `www.` redirect): open <https://www.stakebuildingaccess.org>. Expected: redirects to the apex.

Confirm the `mail.` records are still intact:

```bash
dig CNAME <resend-dkim-host>.mail.stakebuildingaccess.org +short
dig TXT  _dmarc.mail.stakebuildingaccess.org +short
```

Expected: both still resolve to the Resend-issued values from T-04. If either is empty, your apex edits accidentally clobbered a `mail.` record at the registrar — restore from the registrar's audit log or re-add per the Resend dashboard.

### 2.7 Decommission `kindoo.csnorth.org`

Per F17, the legacy GitHub-Pages-iframe-wrapper URL is decommissioned at this point. Whether to (a) redirect to the new domain, (b) leave dormant pointing to a "moved" page, or (c) take down entirely is a separate decision tied to the cutover communication plan — flag it with the operator before the window opens. The Phase 11 cutover checklist in `docs/firebase-migration.md` calls this out as a deferred decision; record the chosen path in `infra/runbooks/cutover.md` (or this runbook's notes section) once made.

---

## Troubleshooting

### Firebase console shows "Needs Setup" indefinitely

The A records aren't resolving from Google's perspective. Verify with `dig` from a network outside Google's infra; if `dig` shows the right IPs but Firebase doesn't budge, give it longer (up to 24h) — Google's DNS-resolution cache for cert validation is independent of the public DNS hierarchy and occasionally lags.

### Browser shows "Your connection is not private" / cert warning

The Let's Encrypt cert hasn't issued yet. Firebase console will show `Pending` for the cert column. Wait. Don't try to bypass the warning during this window — once the cert lands, the warning disappears on a hard refresh.

### Sign-in popup fails with `auth/unauthorized-domain`

The domain isn't in the project's Authorized Domains list. Re-check Section 1.5 (staging) or Section 2.5 (prod). Note the staging and prod projects have separate lists — adding a domain to one doesn't add it to the other.

### `mail.` records broke after editing the apex

The registrar UI conflated apex edits with subdomain edits. Restore the Resend records from your registrar's audit log; if not available, copy them again from the Resend dashboard's domain configuration screen. Re-verify with `dig` per Section 2.6.

### Optional `www.` redirect serves the SPA instead of redirecting

The redirect checkbox wasn't set when you added `www.` in step 2.1. Edit the `www.` entry in the Firebase console and toggle "Redirect to" → set target to `https://stakebuildingaccess.org`.

---

## Cross-references

- F17 in `docs/firebase-migration.md` — chosen-domain rationale; apex/subdomain split that keeps Resend's DNS independent of Hosting.
- Phase 11 cutover checklist in `docs/firebase-migration.md` (around the "DNS for the new domain" + "Legacy `kindoo.csnorth.org` decommission" subsections) — this runbook is the procedure that fulfills those sub-tasks.
- `infra/runbooks/resend-api-key-setup.md` — the Resend side of the F17 mail-subdomain story (API key into Secret Manager). DKIM CNAME + DMARC TXT records were set up in T-04; this runbook does NOT modify them.
- `infra/runbooks/provision-firebase-projects.md` — the prereq B1 runbook that creates the two Firebase projects this one targets.
