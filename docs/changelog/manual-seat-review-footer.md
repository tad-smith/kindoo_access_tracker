# SBA reminder footer on the quarterly manual-seat review

**Shipped:** 2026-11-09
**Commits:** `feat/review-email-footer`.

## What shipped

The quarterly manual-seat review email now ends, on a ward/branch scope, with a footer below the `Review the roster` button: a divider, then smaller grey text headed `Using Stake Building Access`. It links the app root and the requester guide, says SBA is where the bishopric requests access, sees who in their ward/branch has access, and requests that access be removed, and gives the generic sign-in instruction.

Many bishopric members were given access before the welcome email existed and never received one; the review is the only recurring mail they get, so it carries the reminder.

## Deviations from the pre-change spec

- **Ward/branch review mails carry a footer; the stake scope's does not.** The stake scope mails the Kindoo Managers. Spec: §9 "Body shape".
- **Two more links are built per send** (`/` and `/help/requesting-access.html`). A link-build failure returns `'failed'`, same as the CTA link, so it does not consume the quarter.
