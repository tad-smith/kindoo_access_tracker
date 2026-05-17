// Unit tests for the Kindoo session-reading helper. Mocks a Storage so
// the happy path + each error arm round-trips deterministically.
//
// The active-EID resolution went DOM-scrape in fix(extension):
// active-site EID via DOM-scrape — see `auth.ts` for why
// `localStorage.state.sites.ids[0]` was the wrong source. These tests
// drive `readActiveEidFromDom` against jsdom fixtures and exercise
// `readKindooSession` end-to-end with the real `window.localStorage`
// (since the helper reads through `window.localStorage` directly).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readActiveEidFromDom, readKindooSession } from './auth';

function mkStorage(items: Record<string, string>): Storage {
  const map = new Map(Object.entries(items));
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    key(i: number) {
      return Array.from(map.keys())[i] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, value);
    },
  };
}

/** Build the `localStorage.state` JSON Kindoo writes — entities keyed
 * by EID, each carrying an `EnvironmentName`. */
function stateWith(entities: Record<number, string>): string {
  const built: Record<string, { EnvironmentName: string }> = {};
  for (const [eid, name] of Object.entries(entities)) {
    built[eid] = { EnvironmentName: name };
  }
  return JSON.stringify({
    sites: {
      ids: Object.keys(entities).map(Number),
      entities: built,
    },
  });
}

/** Install JSON onto `window.localStorage.state` for the DOM-scrape
 * tests. The helper reads `window.localStorage` directly. */
function installState(json: string | null): void {
  if (json === null) {
    window.localStorage.removeItem('state');
  } else {
    window.localStorage.setItem('state', json);
  }
}

/** Render a single `<div dir="auto">` carrying the given text. The
 * element is attached to `document.body` so jsdom lays it out and
 * `offsetParent` returns the body rather than null. */
function renderVisibleSiteHeader(text: string): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('dir', 'auto');
  el.textContent = text;
  document.body.append(el);
  return el;
}

function renderHiddenSiteHeader(text: string): HTMLElement {
  // Hide via an ancestor with `display: none`. jsdom sets
  // `offsetParent === null` when any ancestor is display: none, matching
  // browser behaviour and exercising the visibility filter directly.
  const wrapper = document.createElement('div');
  wrapper.style.display = 'none';
  const el = document.createElement('div');
  el.setAttribute('dir', 'auto');
  el.textContent = text;
  wrapper.append(el);
  document.body.append(wrapper);
  return el;
}

describe('readActiveEidFromDom', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  it('returns the EID when exactly one visible header matches a known EnvironmentName', () => {
    installState(stateWith({ 26441: 'Foreign Stake', 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Home Stake');
    expect(readActiveEidFromDom()).toBe(27994);
  });

  it('returns null when two visible headers match (e.g. the My Sites listing page)', () => {
    installState(stateWith({ 26441: 'Foreign Stake', 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Home Stake');
    renderVisibleSiteHeader('Foreign Stake');
    expect(readActiveEidFromDom()).toBeNull();
  });

  it('returns null when the matching site name is in a hidden element', () => {
    installState(stateWith({ 27994: 'Home Stake' }));
    renderHiddenSiteHeader('Home Stake');
    expect(readActiveEidFromDom()).toBeNull();
  });

  it('returns null when no visible header matches any EnvironmentName', () => {
    installState(stateWith({ 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Something Else');
    expect(readActiveEidFromDom()).toBeNull();
  });

  it('returns null when localStorage.state is missing', () => {
    // No state installed.
    renderVisibleSiteHeader('Home Stake');
    expect(readActiveEidFromDom()).toBeNull();
  });

  it('returns null when localStorage.state is malformed JSON', () => {
    installState('{not-json');
    renderVisibleSiteHeader('Home Stake');
    expect(readActiveEidFromDom()).toBeNull();
  });

  it('returns null when sites.entities is missing', () => {
    installState(JSON.stringify({ sites: {} }));
    renderVisibleSiteHeader('Home Stake');
    expect(readActiveEidFromDom()).toBeNull();
  });

  it('returns null when no [dir="auto"] elements are in the DOM', () => {
    installState(stateWith({ 27994: 'Home Stake' }));
    // No header rendered.
    expect(readActiveEidFromDom()).toBeNull();
  });

  it('trims surrounding whitespace from text nodes before matching', () => {
    installState(stateWith({ 27994: 'Home Stake' }));
    renderVisibleSiteHeader('  Home Stake  ');
    expect(readActiveEidFromDom()).toBe(27994);
  });

  it('returns the EID when the same name appears in two visible nodes (single underlying site)', () => {
    // Two DOM nodes both rendering the active site's name resolve to a
    // single EID in the matches set — not ambiguous.
    installState(stateWith({ 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Home Stake');
    renderVisibleSiteHeader('Home Stake');
    expect(readActiveEidFromDom()).toBe(27994);
  });
});

describe('readKindooSession', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
  });

  it('returns ok with token + DOM-scraped EID when both are present', () => {
    const storage = mkStorage({
      kindoo_token: '5e94a57a-3f08-4681-a01a-4d7ef6b28b9c',
    });
    installState(stateWith({ 26441: 'Foreign Stake', 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Home Stake');
    const result = readKindooSession(storage);
    expect(result).toEqual({
      ok: true,
      session: { token: '5e94a57a-3f08-4681-a01a-4d7ef6b28b9c', eid: 27994 },
    });
  });

  it('returns no-token when kindoo_token is missing', () => {
    installState(stateWith({ 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Home Stake');
    expect(readKindooSession(mkStorage({}))).toEqual({ ok: false, error: 'no-token' });
  });

  it('returns no-token when kindoo_token is empty / whitespace', () => {
    installState(stateWith({ 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Home Stake');
    expect(readKindooSession(mkStorage({ kindoo_token: '   ' }))).toEqual({
      ok: false,
      error: 'no-token',
    });
  });

  it('returns no-eid when no visible site header matches any known EnvironmentName', () => {
    installState(stateWith({ 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Some Other Page');
    expect(readKindooSession(mkStorage({ kindoo_token: 'tok' }))).toEqual({
      ok: false,
      error: 'no-eid',
    });
  });

  it('returns no-eid when multiple sites are visible at once (My Sites listing page)', () => {
    installState(stateWith({ 26441: 'Foreign Stake', 27994: 'Home Stake' }));
    renderVisibleSiteHeader('Home Stake');
    renderVisibleSiteHeader('Foreign Stake');
    expect(readKindooSession(mkStorage({ kindoo_token: 'tok' }))).toEqual({
      ok: false,
      error: 'no-eid',
    });
  });

  it('returns no-eid when state key is missing', () => {
    renderVisibleSiteHeader('Home Stake');
    expect(readKindooSession(mkStorage({ kindoo_token: 'tok' }))).toEqual({
      ok: false,
      error: 'no-eid',
    });
  });
});
