import type { Response } from 'express';

/** An error whose message is safe and meant to be shown to the client, with its HTTP status. */
export class AppError extends Error {
    constructor(readonly status: number, message: string) {
        super(message);
        this.name = new.target.name;
    }
}

export class NotFoundError extends AppError {
    constructor(message: string) {
        super(404, message);
    }
}

/** The request is valid but conflicts with current state (quota full, store closed, …). */
export class ConflictError extends AppError {
    constructor(message: string) {
        super(409, message);
    }
}

/** An upstream service (Biteship, …) rejected the call; its message is shown to admins. */
export class UpstreamError extends AppError {
    constructor(message: string) {
        super(502, message);
    }
}

export const GENERIC_ERROR_MESSAGE = 'Terjadi kesalahan server. Silakan coba lagi.';

/**
 * Sends an error response. AppErrors keep their status and message; anything else is logged
 * with its details and answered with a generic 500, so DB/driver internals never reach clients.
 */
// Postgres errors caused by bad input, mapped to client errors with a safe message
// (the raw message would leak table/constraint names).
const PG_CLIENT_ERRORS: Record<string, [number, string]> = {
    '23505': [409, 'Data sudah ada'],                    // unique_violation
    '23503': [400, 'Data terkait tidak ditemukan'],      // foreign_key_violation
    '23514': [400, 'Nilai tidak valid'],                 // check_violation
    '23502': [400, 'Data wajib belum diisi'],            // not_null_violation
    '22P02': [400, 'Format data tidak valid'],           // invalid_text_representation
    '22007': [400, 'Format tanggal/waktu tidak valid'],  // invalid_datetime_format
    '22008': [400, 'Tanggal/waktu di luar jangkauan'],   // datetime_field_overflow
    '22003': [400, 'Angka di luar jangkauan'],           // numeric_value_out_of_range
};

export const sendError = (res: Response, err: unknown, context?: string) => {
    if (err instanceof AppError) {
        res.status(err.status).json({ status: 'error', message: err.message });
        return;
    }
    const pgCode = (err as { code?: unknown })?.code;
    if (typeof pgCode === 'string' && PG_CLIENT_ERRORS[pgCode]) {
        const [status, message] = PG_CLIENT_ERRORS[pgCode];
        console.warn(`[error]${context ? ` ${context}` : ''} pg ${pgCode}:`, (err as Error).message);
        res.status(status).json({ status: 'error', message });
        return;
    }
    console.error(`[error]${context ? ` ${context}` : ''}`, err);
    res.status(500).json({ status: 'error', message: GENERIC_ERROR_MESSAGE });
};
