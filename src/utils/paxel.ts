import { formatWAPhone } from './phone';

// Paxel for Store Delivery (docs/plan-paxel-whitelist.md): only the "small" service, only for
// customers in PAXEL_WHITELIST, only to destinations outside Jabodetabek.

export const PAXEL_COURIER = 'paxel';
export const PAXEL_SERVICE = 'small';

/** PAXEL_WHITELIST: WhatsApp numbers (comma-separated, any format). Empty = nobody gets Paxel. */
const paxelWhitelist = () =>
    (process.env.PAXEL_WHITELIST || '').split(',').map(p => formatWAPhone(p.trim())).filter(Boolean);

export const isPaxelAllowed = (phone: string | null | undefined) =>
    !!phone && paxelWhitelist().includes(formatWAPhone(phone));

/**
 * Paxel is quoted and booked without box dimensions: with the real sizes Biteship offers "small" only
 * for about one box, without them up to ~5 kg. Dimension logic is deliberately left out for now.
 */
export const withoutDimensions = <T extends Record<string, unknown>>(item: T) => {
    const { length: _length, width: _width, height: _height, ...rest } = item;
    return rest;
};
