// Domain types barrel. Phase 2 ships only the auth-related shapes
// (claims, principal, userIndex bridge). Phase 3 adds Seat / Request /
// Access / Audit / Stake types alongside.
export type { CustomClaims, Principal, StakeClaims } from './auth.js';
export type { TimestampLike, UserIndexEntry } from './userIndex.js';
