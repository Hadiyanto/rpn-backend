import { formatWAPhone } from './phone';
import { todayWIB } from './date';
import { AppError } from './errors';

export { todayWIB };

/** Input error that should be reported to the client as HTTP 400. */
export class ValidationError extends AppError {
    constructor(message: string) {
        super(400, message);
    }
}

export const MAX_ORDER_ITEMS = 20;
export const MAX_ITEM_QTY = 50;
const MAX_NAME_LENGTH = 255;
const MAX_NOTE_LENGTH = 1000;

export interface ValidOrderItem {
    box_type: 'FULL' | 'HALF';
    name: string;
    qty: number;
    /** Chosen variant ids. Optional so older clients / legacy edits keep working. */
    variant_ids?: number[];
}

// HAMPERS was removed as a product. Old HAMPERS rows may still exist in order_items
// (the DB constraint still allows them), but new orders/edits must not create any.
export function assertValidBoxType(boxType: unknown): asserts boxType is 'FULL' | 'HALF' {
    if (boxType === 'HAMPERS') {
        throw new ValidationError('Hampers sudah tidak tersedia');
    }
    if (boxType !== 'FULL' && boxType !== 'HALF') {
        throw new ValidationError(`box_type harus FULL atau HALF, got: ${String(boxType)}`);
    }
}

export const validateOrderItems = (pesanan: unknown): ValidOrderItem[] => {
    if (!Array.isArray(pesanan) || pesanan.length === 0) {
        throw new ValidationError('pesanan tidak boleh kosong');
    }
    if (pesanan.length > MAX_ORDER_ITEMS) {
        throw new ValidationError(`Maksimal ${MAX_ORDER_ITEMS} item per pesanan`);
    }

    return pesanan.map((raw, idx) => {
        const item = (raw ?? {}) as Record<string, unknown>;
        const label = `Item ${idx + 1}`;

        const box_type = item.box_type;
        assertValidBoxType(box_type);

        if (typeof item.qty !== 'number' || !Number.isInteger(item.qty) || item.qty < 1 || item.qty > MAX_ITEM_QTY) {
            throw new ValidationError(`${label}: qty harus bilangan bulat 1–${MAX_ITEM_QTY}`);
        }

        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!name || name.length > MAX_NAME_LENGTH) {
            throw new ValidationError(`${label}: nama rasa wajib diisi (maks ${MAX_NAME_LENGTH} karakter)`);
        }

        let variant_ids: number[] | undefined;
        if (item.variant_ids !== undefined && item.variant_ids !== null) {
            if (!Array.isArray(item.variant_ids) || item.variant_ids.some(id => !Number.isInteger(Number(id)) || Number(id) < 1)) {
                throw new ValidationError(`${label}: variant_ids tidak valid`);
            }
            // An empty list is treated as "not provided" (e.g. legacy item re-saved without flavors picked).
            variant_ids = item.variant_ids.length > 0 ? item.variant_ids.map(Number) : undefined;
        }

        return { box_type, name, qty: item.qty, ...(variant_ids ? { variant_ids } : {}) };
    });
};

const isRealDate = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
};

export const validatePickupDate = (date: unknown, opts: { allowPast?: boolean; now?: Date } = {}): string => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !isRealDate(date)) {
        throw new ValidationError('pickup_date harus berformat YYYY-MM-DD');
    }
    if (!opts.allowPast && date < todayWIB(opts.now)) {
        throw new ValidationError('Tanggal pengambilan tidak boleh di masa lalu');
    }
    return date;
};

const isValidClock = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h >= 0 && h <= 23 && m >= 0 && m <= 59;
};

/** Accepts "HH:mm" or a range "HH:mm - HH:mm". Empty/absent means "not specified". */
export const validatePickupTime = (time: unknown): string | undefined => {
    if (time === undefined || time === null || time === '') return undefined;
    if (typeof time !== 'string') {
        throw new ValidationError('pickup_time tidak valid');
    }
    const match = time.trim().match(/^(\d{2}:\d{2})(?: - (\d{2}:\d{2}))?$/);
    if (!match || !isValidClock(match[1]) || (match[2] && !isValidClock(match[2]))) {
        throw new ValidationError('pickup_time harus berformat HH:mm');
    }
    return time.trim();
};

export const validatePhone = (phone: unknown): string => {
    const digits = typeof phone === 'string' ? formatWAPhone(phone) : '';
    if (digits.length < 9 || digits.length > 15) {
        throw new ValidationError('Nomor WhatsApp tidak valid');
    }
    return phone as string;
};

export const validateCustomerName = (name: unknown): string => {
    const trimmed = typeof name === 'string' ? name.trim() : '';
    if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
        throw new ValidationError(`Nama pelanggan wajib diisi (maks ${MAX_NAME_LENGTH} karakter)`);
    }
    return trimmed;
};

export const validateNote = (note: unknown): string | null | undefined => {
    if (note === undefined || note === null) return note;
    if (typeof note !== 'string' || note.length > MAX_NOTE_LENGTH) {
        throw new ValidationError(`Catatan maksimal ${MAX_NOTE_LENGTH} karakter`);
    }
    return note;
};

export const validateStoreId = (storeId: unknown): number => {
    const n = Number(storeId);
    if (!Number.isInteger(n) || n < 1) {
        throw new ValidationError('store_id tidak valid');
    }
    return n;
};
