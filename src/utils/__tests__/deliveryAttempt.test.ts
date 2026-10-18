import { describe, expect, it } from 'vitest';
import { nextAttemptStatus, providerStatusNote } from '../deliveryAttempt';

describe('providerStatusNote', () => {
    const history = [
        { status: 'confirmed', note: 'Courier order is confirmed.' },
        { status: 'courier_not_found', note: ' Order is rejected bacause no courier picking up order ' },
    ];

    it("takes the note of the history entry matching the order's status", () => {
        expect(providerStatusNote({ status: 'courier_not_found', courier: { history } }))
            .toBe('Order is rejected bacause no courier picking up order');
        expect(providerStatusNote({ status: 'confirmed', courier: { history } })).toBe('Courier order is confirmed.');
    });

    it('falls back to the latest entry, and to null without a note', () => {
        expect(providerStatusNote({ status: 'cancelled', courier: { history } }))
            .toBe('Order is rejected bacause no courier picking up order');
        expect(providerStatusNote({ status: 'cancelled', courier: { history: [{ status: 'cancelled', note: '' }] } })).toBeNull();
        expect(providerStatusNote({ status: 'cancelled' })).toBeNull();
        expect(providerStatusNote(undefined)).toBeNull();
    });
});

describe('nextAttemptStatus', () => {
    it('follows the provider while the attempt is still open', () => {
        expect(nextAttemptStatus('PENDING', 'ALLOCATED')).toBe('ALLOCATED');
        expect(nextAttemptStatus('ALLOCATED', 'DELIVERED')).toBe('DELIVERED');
        expect(nextAttemptStatus('PENDING', 'FAILED')).toBe('FAILED');
        expect(nextAttemptStatus('PENDING', null)).toBeNull();
    });

    it('never reopens a FAILED, CANCELLED or DELIVERED attempt', () => {
        expect(nextAttemptStatus('FAILED', 'PENDING')).toBe('FAILED');
        expect(nextAttemptStatus('FAILED', 'ALLOCATED')).toBe('FAILED');
        expect(nextAttemptStatus('CANCELLED', 'ALLOCATED')).toBe('CANCELLED');
        expect(nextAttemptStatus('DELIVERED', 'PENDING')).toBe('DELIVERED');
    });
});
