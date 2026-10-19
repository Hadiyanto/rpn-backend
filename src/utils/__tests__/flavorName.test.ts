import { describe, expect, it } from 'vitest';
import { flavorName } from '../flavorName';

describe('flavorName', () => {
    it('one flavor is its own name', () => {
        expect(flavorName(['Choco Special'])).toBe('Choco Special');
    });

    it('several flavors become "Mix A Dan B", sorted like the order form', () => {
        expect(flavorName(['Vanilla', 'Choco Cheese'])).toBe('Mix Choco Cheese Dan Vanilla');
        expect(flavorName(['Keju', 'Dark Choco', 'Vanilla'])).toBe('Mix Dark Choco Dan Keju Dan Vanilla');
        // Code-unit order (uppercase before lowercase), same as the frontend's `<` comparison.
        expect(flavorName(['choco', 'Vanilla'])).toBe('Mix Vanilla Dan choco');
    });

    it('ignores blanks', () => {
        expect(flavorName([' Choco ', ''])).toBe('Choco');
        expect(flavorName([])).toBe('');
    });
});
