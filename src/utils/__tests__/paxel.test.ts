import { afterEach, describe, expect, it } from 'vitest';
import { isJabodetabek, isOutsideJabodetabek } from '../deliveryArea';
import { isPaxelAllowed, withoutDimensions } from '../paxel';

// Level-1 / level-2 names as Biteship's sandbox rates response returned them (2026-10-19).
const area = (l1: string, l2: string) => ({ administrative_division_level_1_name: l1, administrative_division_level_2_name: l2 });

describe('Jabodetabek', () => {
    it('Jakarta, Bogor, Depok, Tangerang (Selatan) and Bekasi — city and regency — are inside', () => {
        for (const a of [
            area('DKI Jakarta', 'Jakarta Selatan'), area('DKI Jakarta', 'Kepulauan Seribu'),
            area('Jawa Barat', 'Depok'), area('Jawa Barat', 'Bogor'), area('Jawa Barat', 'Bekasi'),
            area('Banten', 'Tangerang'), area('Banten', 'Tangerang Selatan'),
            area('Jawa Barat', 'Kota Bekasi'), area('Jawa Barat', 'Kabupaten Bogor'),
        ]) {
            expect(isJabodetabek(a)).toBe(true);
            expect(isOutsideJabodetabek(a)).toBe(false);
        }
    });

    it('Bandung, Karawang, Semarang are outside', () => {
        for (const a of [area('Jawa Barat', 'Bandung'), area('Jawa Barat', 'Karawang'), area('Jawa Tengah', 'Semarang')]) {
            expect(isOutsideJabodetabek(a)).toBe(true);
        }
    });

    it('an unknown destination never counts as outside', () => {
        expect(isOutsideJabodetabek(undefined)).toBe(false);
        expect(isOutsideJabodetabek(null)).toBe(false);
        expect(isOutsideJabodetabek({})).toBe(false);
        expect(isOutsideJabodetabek(area('Jawa Barat', ''))).toBe(false);
    });
});

describe('Paxel whitelist', () => {
    afterEach(() => { delete process.env.PAXEL_WHITELIST; });

    it('empty whitelist = nobody', () => {
        expect(isPaxelAllowed('081234567890')).toBe(false);
        process.env.PAXEL_WHITELIST = ' , ';
        expect(isPaxelAllowed('081234567890')).toBe(false);
    });

    it('matches any phone format', () => {
        process.env.PAXEL_WHITELIST = '0812-3456-7890, +62 811 111 111';
        expect(isPaxelAllowed('081234567890')).toBe(true);
        expect(isPaxelAllowed('6281234567890')).toBe(true);
        expect(isPaxelAllowed('+62 812 3456 7890')).toBe(true);
        expect(isPaxelAllowed('0811111111')).toBe(true);
        expect(isPaxelAllowed('081299999999')).toBe(false);
        expect(isPaxelAllowed(null)).toBe(false);
        expect(isPaxelAllowed('')).toBe(false);
    });
});

describe('withoutDimensions', () => {
    it('drops length/width/height and keeps the rest', () => {
        expect(withoutDimensions({ name: 'Box', value: 60000, weight: 600, length: 20, width: 10, height: 5, quantity: 2 }))
            .toEqual({ name: 'Box', value: 60000, weight: 600, quantity: 2 });
    });
});
