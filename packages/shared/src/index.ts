// Public surface of @kindoo/shared. Both apps/web/ and functions/ import
// from here. Phase 1 shipped canonical-email helpers; Phase 2 adds the
// auth surface (claims, principal, userIndex bridge); Phase 3 will add
// domain types (Seat / Request / Access / Audit / Stake) and zod
// schemas alongside.

export { canonicalEmail, emailsEqual } from './canonicalEmail.js';
export { principalFromClaims } from './principal.js';
export type {
  CustomClaims,
  Principal,
  StakeClaims,
  TimestampLike,
  UserIndexEntry,
} from './types/index.js';
