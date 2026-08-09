import { describe, expect, it } from 'vitest';
import { findUnitNameCollision, unitNameCollisionMessage } from './unitNameCollision.js';

describe('findUnitNameCollision', () => {
  it('returns null when no existing unit shares a variant', () => {
    expect(findUnitNameCollision('Oak', ['Maple', 'Prairie Ward'])).toBeNull();
    expect(findUnitNameCollision('Peterson Branch', ['Maple Ward'])).toBeNull();
  });

  it('returns null for an empty or whitespace-only name', () => {
    expect(findUnitNameCollision('', ['Maple'])).toBeNull();
    expect(findUnitNameCollision('   ', ['Maple'])).toBeNull();
  });

  it('rejects a bare ward name against a stored suffixed one', () => {
    // The regression: "Maple" and "Maple Ward" are the same unit, and a
    // verbatim string compare let the pair coexist. Both then registered
    // `maple` and `maple ward` in the parser and the later one won.
    expect(findUnitNameCollision('Maple', ['Maple Ward'])).toEqual({
      existingName: 'Maple Ward',
      sharedVariant: 'maple',
    });
    expect(findUnitNameCollision('Maple Ward', ['Maple'])).toEqual({
      existingName: 'Maple',
      sharedVariant: 'maple',
    });
  });

  it('rejects a ward that shadows a branch of the same place name', () => {
    // Canonical names differ ("Olive Branch" vs "Olive Branch Ward") so
    // a kindooScopeName comparison would allow the pair — but both
    // answer to "olive branch" and the parser can only key it once.
    expect(findUnitNameCollision('Olive Branch Ward', ['Olive Branch'])).toEqual({
      existingName: 'Olive Branch',
      sharedVariant: 'olive branch',
    });
    expect(findUnitNameCollision('Olive Branch', ['Olive Branch Ward'])).toEqual({
      existingName: 'Olive Branch Ward',
      sharedVariant: 'olive branch',
    });
  });

  it('matches case-insensitively and trims', () => {
    expect(findUnitNameCollision('  maple WARD ', ['Maple'])).not.toBeNull();
    expect(findUnitNameCollision('PETERSON BRANCH', ['  Peterson Branch  '])).not.toBeNull();
  });

  it('does not collide two branches of different places', () => {
    expect(findUnitNameCollision('Peterson Branch', ['Olive Branch'])).toBeNull();
  });

  it('reports the first colliding name when several exist', () => {
    const clash = findUnitNameCollision('Maple', ['Prairie', 'Maple Ward', 'Maple']);
    expect(clash?.existingName).toBe('Maple Ward');
  });
});

describe('unitNameCollisionMessage', () => {
  it('is null when the name is free', () => {
    expect(unitNameCollisionMessage('Oak', ['Maple Ward'])).toBeNull();
  });

  it('names the existing unit when the name is simply taken', () => {
    const msg = unitNameCollisionMessage('  maple ward ', ['Maple Ward']);
    expect(msg).toBe(
      'Another ward or branch already uses the name "Maple Ward". ' +
        'Ward and branch names must be unique.',
    );
  });

  it('explains that the optional suffix makes it the same ward', () => {
    // Without the reason this reads as a false positive: the operator
    // typed a name they can see is not in the list.
    const msg = unitNameCollisionMessage('Maple', ['Maple Ward']);
    expect(msg).toBe(
      '"Maple" and the existing "Maple Ward" are the same ward — the " Ward" suffix is ' +
        'optional. Ward and branch names must be unique.',
    );
  });

  it('explains the shared form when a ward shadows a same-named branch', () => {
    const msg = unitNameCollisionMessage('Olive Branch Ward', ['Olive Branch']);
    expect(msg).toBe(
      '"Olive Branch Ward" collides with the existing "Olive Branch": Kindoo Sync reads both ' +
        'as "Olive Branch" and could not tell them apart. Ward and branch names must be unique.',
    );
  });

  it('echoes a readable shared form rather than the normalised key', () => {
    const msg = unitNameCollisionMessage('OLIVE BRANCH WARD', ['Olive Branch']);
    expect(msg).toContain('reads both as "Olive Branch"');
    expect(msg).not.toContain('"olive branch"');
  });
});
