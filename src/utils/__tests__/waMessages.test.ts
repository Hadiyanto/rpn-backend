import { describe, expect, it } from 'vitest';
import { buildDoneOrderMessage, buildNewOrderMessage, buildPaidOrderMessage, type StoreInfo } from '../waMessages';
import { storeMapsUrl } from '../../services/store.service';

const depok: StoreInfo = {
    name: 'Raja Pisang Nugget Depok',
    address: 'Jl. Margonda No. 1, Depok',
    maps_url: 'https://maps.app.goo.gl/depok123',
    bank: { name: 'Mandiri', number: '1234567890', holder: 'Toko Depok' },
    has_qris: true,
};
const base = {
    customer_name: 'Sari', order_id: 7, order_details: '- 1x Full Box (Keju)', total_box: 1, total_amount: '65.000',
    status_link: 'https://rajapisangnugget.com/status/abc', store: depok,
};

describe('WhatsApp messages use the order\'s store', () => {
    it('new order, TRANSFER: the store\'s bank account + status link; nothing hardcoded', () => {
        const m = buildNewOrderMessage({ ...base, payment_method: 'TRANSFER' });
        expect(m).toContain('Bank: Mandiri\nNo Rek: 1234567890\nA/N: Toko Depok');
        expect(m).toContain('https://rajapisangnugget.com/status/abc');
        expect(m).toContain('🏪 Store: Raja Pisang Nugget Depok');
        expect(m).not.toMatch(/BCA|1280119748|Anggita|Kalibata/);
    });

    it('new order, store without a bank account: account sent over WhatsApp', () => {
        const m = buildNewOrderMessage({ ...base, payment_method: 'TRANSFER', store: { ...depok, bank: null } });
        expect(m).toContain('Nomor rekening akan kami kirim lewat WhatsApp');
    });

    it.each([
        ['QRIS', 'scan QRIS'],
        ['CASH', 'Pembayaran tunai saat pengambilan'],
    ])('new order, %s', (method, text) => {
        const m = buildNewOrderMessage({ ...base, payment_method: method });
        expect(m).toContain(text);
        expect(m).not.toContain('No Rek');
    });

    it('new order, DOKU: the payment link replaces the other instructions', () => {
        const m = buildNewOrderMessage({ ...base, payment_method: 'DOKU', payment_link: 'https://doku/pay' });
        expect(m).toContain('https://doku/pay');
        expect(m).not.toContain('No Rek');
    });

    it('PAID pickup: the store\'s address and Maps link', () => {
        const m = buildPaidOrderMessage({ customer_name: 'Sari', order_id: 7, scheduleDate: 'Sabtu, 11 Okt', store: depok });
        expect(m).toContain('Raja Pisang Nugget Depok\nJl. Margonda No. 1, Depok\n📍 Google Maps:\nhttps://maps.app.goo.gl/depok123');
        expect(m).not.toMatch(/Kalibata|Rawajati|633auSZ14ucptMDS7/);
    });

    it('DONE pickup: ready at the store', () => {
        expect(buildDoneOrderMessage({ customer_name: 'Sari', order_id: 7, store: depok })).toContain('siap diambil sekarang* di Raja Pisang Nugget Depok');
    });
});

describe('storeMapsUrl', () => {
    it('prefers the store\'s own link, else builds one from the coordinates', () => {
        expect(storeMapsUrl({ maps_url: 'https://maps.app.goo.gl/x', latitude: 1, longitude: 2 })).toBe('https://maps.app.goo.gl/x');
        expect(storeMapsUrl({ maps_url: null, latitude: -6.26, longitude: 106.85 })).toBe('https://www.google.com/maps/search/?api=1&query=-6.26,106.85');
        expect(storeMapsUrl({ maps_url: null, latitude: null, longitude: null })).toBeNull();
    });
});
