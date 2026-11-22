# Claims are not minted for an unverified email address

**2026-09-07**

`onAuthUserCreate` seeded custom claims from `user.email` with no check that
the account holder controlled that address. `seedClaimsFromRoleData` resolves
`kindooManagers`, `access` and `platformSuperadmins` rows by email alone, and
nothing in `functions/`, `firestore.rules` or `apps/web/` consulted
`emailVerified` or `sign_in_provider`.

With the Email/Password provider enabled, that is reachable: the Firebase Web
API key is public (it ships in the bundle) and the Identity Toolkit `signUp`
endpoint accepts it. Creating an account for a role-holding address that had
never signed in returned that address's full claim block. The roster is
imported from LCR, so `access/{canonical}` rows routinely exist for members
who have never opened the app.

`signUp` fails with `EMAIL_EXISTS` against an address that already has an
account, so the population at risk is exactly the un-signed-in half of the
roster — not the addresses an attacker is most likely to know.

## The fix

`onAuthUserCreate` now returns early unless `user.emailVerified`.

It bails **before** the `userIndex` write, not merely before the claim seed.
`uidForCanonical` reads that document, so leaving an entry would let
`syncAccessClaims` / `syncManagersClaims` / `syncSuperadminClaims` mint onto
that uid later, on any role-data write. One gate, one place.

Verified against the Auth emulator rather than assumed, because a wrong answer
here locks out every manager without a Google account:

```
password signUp   -> emailVerified = false
email-link signIn -> emailVerified = true
```

Google is verified by the provider. So both supported sign-in paths clear the
gate and only the attack path is blocked.

## Console setting

The Email/Password provider stays **enabled**, because disabling it also
disables email-link sign-in — the two share one toggle, and email link is the
path D33 exists to serve. This gate is therefore the only control, not a
belt-and-braces addition to a console setting.

## Consequence worth knowing

The trigger fires once per account, ever, so an account created unverified is
not re-seeded if it verifies later. No supported flow produces one, so nothing
legitimate is stranded today — but a future flow that does would need a
re-seed path.

Every pre-existing spec in `functions/tests/onAuthUserCreate.test.ts` now
passes `emailVerified: true`, because Admin `createUser` defaults to `false`
and those specs model real sign-ins.
