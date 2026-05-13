// Firebase SDK singleton for the extension.
//
// The extension is its own Firebase Auth client, distinct from the SPA at
// stakebuildingaccess.org. It signs in via the Chrome identity API
// (chrome.identity.getAuthToken), exchanges the Google access token for a
// Firebase credential, and then invokes the SBA-side callables with the
// resulting ID token.
//
// Config values come from build-time env vars (VITE_FIREBASE_*) so the
// same code targets the staging or production SBA project depending on
// which env file vite loads.

import { initializeApp, type FirebaseApp } from 'firebase/app';
// `firebase/auth/web-extension` is the SW-safe entry point. The default
// `firebase/auth` import touches `document` during module init, which
// fatally errors a MV3 service worker ("document is not defined").
import { getAuth, type Auth } from 'firebase/auth/web-extension';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getFunctions, type Functions } from 'firebase/functions';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

let _app: FirebaseApp | undefined;
let _auth: Auth | undefined;
let _firestore: Firestore | undefined;
let _functions: Functions | undefined;

function app(): FirebaseApp {
  if (_app) return _app;
  _app = initializeApp(firebaseConfig);
  return _app;
}

export function auth(): Auth {
  if (_auth) return _auth;
  _auth = getAuth(app());
  return _auth;
}

export function functions(): Functions {
  if (_functions) return _functions;
  _functions = getFunctions(app());
  return _functions;
}

export function firestore(): Firestore {
  if (_firestore) return _firestore;
  _firestore = getFirestore(app());
  return _firestore;
}
