import { afterEach, describe, expect, it } from 'vitest';
import { dokuDigest, dokuSignature, dokuTimestamp, parseDokuExpiredDate, verifyDokuNotification } from '../doku';

const SECRET = 'SK-test-secret';
const CLIENT_ID = 'MCH-0001-10791114622547';

describe('DOKU signature', () => {
    afterEach(() => {
        delete process.env.DOKU_CLIENT_ID;
        delete process.env.DOKU_SECRET_KEY;
    });

    it('formats the timestamp as ISO8601 UTC without milliseconds', () => {
        expect(dokuTimestamp(new Date('2020-08-11T08:45:42.123Z'))).toBe('2020-08-11T08:45:42Z');
    });

    it('digests the body as base64 SHA-256', () => {
        // sha256("{}") in base64
        expect(dokuDigest('{}')).toBe('RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o=');
    });

    it('omits the Digest line for GET requests (no body)', () => {
        const base = { clientId: CLIENT_ID, requestId: 'r1', timestamp: '2020-08-11T08:45:42Z', target: '/orders/v1/status/INV-1' };
        expect(dokuSignature(base, SECRET)).not.toBe(dokuSignature({ ...base, body: '' }, SECRET));
        expect(dokuSignature(base, SECRET)).toMatch(/^HMACSHA256=[A-Za-z0-9+/]+=*$/);
    });

    it('accepts a notification signed with our secret and rejects tampered ones', () => {
        process.env.DOKU_CLIENT_ID = CLIENT_ID;
        process.env.DOKU_SECRET_KEY = SECRET;
        const body = Buffer.from(JSON.stringify({ order: { invoice_number: 'RPN-1-X', amount: 20000 }, transaction: { status: 'SUCCESS' } }));
        const target = '/api/payments/doku/notification';
        const headers = {
            'client-id': CLIENT_ID,
            'request-id': 'req-1',
            'request-timestamp': '2020-08-11T08:45:42Z',
            signature: dokuSignature({ clientId: CLIENT_ID, requestId: 'req-1', timestamp: '2020-08-11T08:45:42Z', target, body }, SECRET),
        };

        expect(verifyDokuNotification(headers, target, body)).toBe(true);
        expect(verifyDokuNotification(headers, target, Buffer.from(body.toString().replace('20000', '1')))).toBe(false);
        expect(verifyDokuNotification(headers, '/other/path', body)).toBe(false);
        expect(verifyDokuNotification({ ...headers, 'client-id': 'MCH-other' }, target, body)).toBe(false);
    });
});

describe('parseDokuExpiredDate', () => {
    it('reads yyyyMMddHHmmss as WIB', () => {
        expect(parseDokuExpiredDate('20240712104711')?.toISOString()).toBe('2024-07-12T03:47:11.000Z');
        expect(parseDokuExpiredDate(undefined)).toBeNull();
    });
});
