import { describe, expect, it, vi } from 'vitest';
import { ConflictError, GENERIC_ERROR_MESSAGE, NotFoundError, sendError } from '../errors';
import { ValidationError } from '../validation';

const fakeRes = () => {
    const res: any = {};
    res.status = vi.fn(() => res);
    res.json = vi.fn(() => res);
    return res;
};

describe('sendError', () => {
    it.each([
        [new ValidationError('qty tidak valid'), 400],
        [new NotFoundError('Order tidak ditemukan'), 404],
        [new ConflictError('MOHON MAAF: Kuota penuh'), 409],
    ])('passes %s through with status %i', (err, status) => {
        const res = fakeRes();
        sendError(res, err);
        expect(res.status).toHaveBeenCalledWith(status);
        expect(res.json).toHaveBeenCalledWith({ status: 'error', message: err.message });
    });

    it('maps Postgres input errors to 4xx with a safe message', () => {
        const res = fakeRes();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        sendError(res, { message: 'new row violates check constraint "orders_payment_method_check"', code: '23514' });
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ status: 'error', message: 'Nilai tidak valid' });
        warn.mockRestore();
    });

    it('hides internal errors behind a generic 500 and logs them', () => {
        const res = fakeRes();
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        sendError(res, { message: 'connection terminated unexpectedly', code: '08006' }, 'ctx');
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ status: 'error', message: GENERIC_ERROR_MESSAGE });
        expect(log).toHaveBeenCalled();
        log.mockRestore();
    });
});
