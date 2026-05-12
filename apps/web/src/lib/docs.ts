// Typed Firestore doc + collection references for every collection in
// `docs/firebase-schema.md` §§3–4. Lets feature hooks issue typed
// reads without re-typing the payload by hand.
//
// Why this layer exists.
//   - Firestore's `doc()` / `collection()` return `DocumentReference<DocumentData>`
//     and `CollectionReference<DocumentData>` by default. Without a
//     converter, every snapshot loses type information at the read
//     boundary.
//   - `withConverter` lets us register one converter per collection that
//     produces the correct shared type. We don't validate fields here
//     (`firestoreDataConverter.fromFirestore` runs after rules-permitted
//     reads, so the data is already what the rules said it would be).
//     The converter is a pure projection — its only job is the type
//     assertion.
//
// Convention.
//   - One `<Entity>Ref(stakeId, id)` for `DocumentReference`.
//   - One `<entities>Col(stakeId)` for `CollectionReference`.
//   - For top-level (cross-stake) collections, no `stakeId` arg.
//   - All callers pass `STAKE_ID` from `./constants` — it is a stable
//     constant in v1; multi-stake makes it dynamic per principal.

import {
  collection,
  doc,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from 'firebase/firestore';
import type {
  Access,
  AccessRequest,
  AuditLog,
  Building,
  KindooManager,
  PlatformAuditLog,
  PlatformSuperadmin,
  Seat,
  Stake,
  StakeCallingTemplate,
  UserIndexEntry,
  Ward,
  WardCallingTemplate,
} from '@kindoo/shared';

// Shared converter factory. The converter is a structural projection —
// no field-level validation here; the data shape is whatever Firestore
// returned. Rules + Cloud Function code have already gated writes to
// the right shape; the runtime contract on reads is "what the rules
// said the shape would be, modulo undefined optional fields."
function passthroughConverter<T>(): FirestoreDataConverter<T> {
  return {
    toFirestore(data: T) {
      return data as unknown as { [key: string]: unknown };
    },
    fromFirestore(snapshot: QueryDocumentSnapshot): T {
      // The shape contract is enforced by rules + by Cloud Function code
      // on the write side. On reads, the SDK gives us back the exact
      // map it stored, which matches the type T by construction.
      return snapshot.data() as T;
    },
  };
}

// ---- Top-level collections (cross-stake) -----------------------------

export function userIndexRef(
  db: Firestore,
  canonicalEmail: string,
): DocumentReference<UserIndexEntry> {
  return doc(db, 'userIndex', canonicalEmail).withConverter(passthroughConverter<UserIndexEntry>());
}

export function userIndexCol(db: Firestore): CollectionReference<UserIndexEntry> {
  return collection(db, 'userIndex').withConverter(passthroughConverter<UserIndexEntry>());
}

export function platformSuperadminRef(
  db: Firestore,
  canonicalEmail: string,
): DocumentReference<PlatformSuperadmin> {
  return doc(db, 'platformSuperadmins', canonicalEmail).withConverter(
    passthroughConverter<PlatformSuperadmin>(),
  );
}

export function platformSuperadminsCol(db: Firestore): CollectionReference<PlatformSuperadmin> {
  return collection(db, 'platformSuperadmins').withConverter(
    passthroughConverter<PlatformSuperadmin>(),
  );
}

export function platformAuditLogRef(
  db: Firestore,
  auditId: string,
): DocumentReference<PlatformAuditLog> {
  return doc(db, 'platformAuditLog', auditId).withConverter(
    passthroughConverter<PlatformAuditLog>(),
  );
}

export function platformAuditLogCol(db: Firestore): CollectionReference<PlatformAuditLog> {
  return collection(db, 'platformAuditLog').withConverter(passthroughConverter<PlatformAuditLog>());
}

// ---- Per-stake collections ------------------------------------------

export function stakeRef(db: Firestore, stakeId: string): DocumentReference<Stake> {
  return doc(db, 'stakes', stakeId).withConverter(passthroughConverter<Stake>());
}

export function stakesCol(db: Firestore): CollectionReference<Stake> {
  return collection(db, 'stakes').withConverter(passthroughConverter<Stake>());
}

export function wardRef(db: Firestore, stakeId: string, wardCode: string): DocumentReference<Ward> {
  return doc(db, 'stakes', stakeId, 'wards', wardCode).withConverter(passthroughConverter<Ward>());
}

export function wardsCol(db: Firestore, stakeId: string): CollectionReference<Ward> {
  return collection(db, 'stakes', stakeId, 'wards').withConverter(passthroughConverter<Ward>());
}

export function buildingRef(
  db: Firestore,
  stakeId: string,
  buildingId: string,
): DocumentReference<Building> {
  return doc(db, 'stakes', stakeId, 'buildings', buildingId).withConverter(
    passthroughConverter<Building>(),
  );
}

export function buildingsCol(db: Firestore, stakeId: string): CollectionReference<Building> {
  return collection(db, 'stakes', stakeId, 'buildings').withConverter(
    passthroughConverter<Building>(),
  );
}

export function kindooManagerRef(
  db: Firestore,
  stakeId: string,
  canonicalEmail: string,
): DocumentReference<KindooManager> {
  return doc(db, 'stakes', stakeId, 'kindooManagers', canonicalEmail).withConverter(
    passthroughConverter<KindooManager>(),
  );
}

export function kindooManagersCol(
  db: Firestore,
  stakeId: string,
): CollectionReference<KindooManager> {
  return collection(db, 'stakes', stakeId, 'kindooManagers').withConverter(
    passthroughConverter<KindooManager>(),
  );
}

export function accessRef(
  db: Firestore,
  stakeId: string,
  canonicalEmail: string,
): DocumentReference<Access> {
  return doc(db, 'stakes', stakeId, 'access', canonicalEmail).withConverter(
    passthroughConverter<Access>(),
  );
}

export function accessCol(db: Firestore, stakeId: string): CollectionReference<Access> {
  return collection(db, 'stakes', stakeId, 'access').withConverter(passthroughConverter<Access>());
}

export function seatRef(
  db: Firestore,
  stakeId: string,
  canonicalEmail: string,
): DocumentReference<Seat> {
  return doc(db, 'stakes', stakeId, 'seats', canonicalEmail).withConverter(
    passthroughConverter<Seat>(),
  );
}

export function seatsCol(db: Firestore, stakeId: string): CollectionReference<Seat> {
  return collection(db, 'stakes', stakeId, 'seats').withConverter(passthroughConverter<Seat>());
}

export function requestRef(
  db: Firestore,
  stakeId: string,
  requestId: string,
): DocumentReference<AccessRequest> {
  return doc(db, 'stakes', stakeId, 'requests', requestId).withConverter(
    passthroughConverter<AccessRequest>(),
  );
}

export function requestsCol(db: Firestore, stakeId: string): CollectionReference<AccessRequest> {
  return collection(db, 'stakes', stakeId, 'requests').withConverter(
    passthroughConverter<AccessRequest>(),
  );
}

export function wardCallingTemplateRef(
  db: Firestore,
  stakeId: string,
  callingName: string,
): DocumentReference<WardCallingTemplate> {
  return doc(
    db,
    'stakes',
    stakeId,
    'wardCallingTemplates',
    encodeURIComponent(callingName),
  ).withConverter(passthroughConverter<WardCallingTemplate>());
}

export function wardCallingTemplatesCol(
  db: Firestore,
  stakeId: string,
): CollectionReference<WardCallingTemplate> {
  return collection(db, 'stakes', stakeId, 'wardCallingTemplates').withConverter(
    passthroughConverter<WardCallingTemplate>(),
  );
}

export function stakeCallingTemplateRef(
  db: Firestore,
  stakeId: string,
  callingName: string,
): DocumentReference<StakeCallingTemplate> {
  return doc(
    db,
    'stakes',
    stakeId,
    'stakeCallingTemplates',
    encodeURIComponent(callingName),
  ).withConverter(passthroughConverter<StakeCallingTemplate>());
}

export function stakeCallingTemplatesCol(
  db: Firestore,
  stakeId: string,
): CollectionReference<StakeCallingTemplate> {
  return collection(db, 'stakes', stakeId, 'stakeCallingTemplates').withConverter(
    passthroughConverter<StakeCallingTemplate>(),
  );
}

export function auditLogRef(
  db: Firestore,
  stakeId: string,
  auditId: string,
): DocumentReference<AuditLog> {
  return doc(db, 'stakes', stakeId, 'auditLog', auditId).withConverter(
    passthroughConverter<AuditLog>(),
  );
}

export function auditLogCol(db: Firestore, stakeId: string): CollectionReference<AuditLog> {
  return collection(db, 'stakes', stakeId, 'auditLog').withConverter(
    passthroughConverter<AuditLog>(),
  );
}
