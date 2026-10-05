import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { UpstreamError } from './errors';

// DOKU Checkout (non-SNAP) client. Docs:
// https://developers.doku.com/accept-payments/doku-checkout/integration-guide/backend-integration
// https://developers.doku.com/get-started-with-doku-api/signature-component/non-snap

/** DOKU_PAYMENT=true sends customers to the DOKU checkout page instead of the manual TRANSFER/QRIS/CASH flow. */
export const isDokuEnabled = () => process.env.DOKU_PAYMENT === 'true';

const baseUrl = () => process.env.DOKU_URL || 'https://api-sandbox.doku.com';
const clientId = () => process.env.DOKU_CLIENT_ID || '';
const secretKey = () => process.env.DOKU_SECRET_KEY || '';

/** Request-Timestamp: ISO8601 in UTC without milliseconds, e.g. 2020-08-11T08:45:42Z. */
export const dokuTimestamp = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Digest: base64(SHA-256(body)) over the exact bytes sent/received. */
export const dokuDigest = (body: string | Buffer) => createHash('sha256').update(body).digest('base64');

export interface SignatureComponents {
    clientId: string;
    requestId: string;
    timestamp: string;
    /** Path only, e.g. /checkout/v1/payment or our notification path. */
    target: string;
    /** Raw JSON body; omitted for GET requests (no Digest line). */
    body?: string | Buffer;
}

/** Signature header value: "HMACSHA256=" + base64(HMAC-SHA256(components, secret)). */
export const dokuSignature = (c: SignatureComponents, secret: string) => {
    const lines = [
        `Client-Id:${c.clientId}`,
        `Request-Id:${c.requestId}`,
        `Request-Timestamp:${c.timestamp}`,
        `Request-Target:${c.target}`,
    ];
    if (c.body !== undefined) lines.push(`Digest:${dokuDigest(c.body)}`);
    return 'HMACSHA256=' + createHmac('sha256', secret).update(lines.join('\n')).digest('base64');
};

/** Verifies the Signature header of an HTTP notification DOKU sent to `target` (our endpoint path). */
export const verifyDokuNotification = (
    headers: Record<string, string | string[] | undefined>,
    target: string,
    rawBody: Buffer | string,
) => {
    const header = (name: string) => {
        const v = headers[name.toLowerCase()];
        return Array.isArray(v) ? v[0] : v;
    };
    const signature = header('Signature');
    const requestId = header('Request-Id');
    const timestamp = header('Request-Timestamp');
    if (!signature || !requestId || !timestamp || !secretKey()) return false;
    if (header('Client-Id') !== clientId()) return false;

    const expected = dokuSignature({ clientId: clientId(), requestId, timestamp, target, body: rawBody }, secretKey());
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};

const dokuRequest = async <T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> => {
    if (!clientId() || !secretKey()) throw new UpstreamError('DOKU belum dikonfigurasi (DOKU_CLIENT_ID / DOKU_SECRET_KEY)');

    const requestId = randomUUID();
    const timestamp = dokuTimestamp();
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            'Client-Id': clientId(),
            'Request-Id': requestId,
            'Request-Timestamp': timestamp,
            Signature: dokuSignature({ clientId: clientId(), requestId, timestamp, target: path, body: payload }, secretKey()),
        },
        body: payload,
    });

    const data: any = await res.json().catch(() => null);
    if (!res.ok) {
        const detail = data?.error_messages?.join(', ') || data?.error?.message || data?.message || `HTTP ${res.status}`;
        console.error(`[DOKU] ${method} ${path} failed (${res.status}):`, data);
        throw new UpstreamError(`DOKU: ${detail}`);
    }
    return data as T;
};

export interface DokuCheckoutRequest {
    order: {
        amount: number;
        invoice_number: string;
        currency?: string;
        callback_url?: string;
        callback_url_result?: string;
        auto_redirect?: boolean;
        line_items?: { id?: string; name: string; price: number; quantity: number; sku?: string; category?: string }[];
    };
    payment?: { payment_due_date?: number; type?: 'SALE' | 'INSTALLMENT' | 'AUTHORIZE'; payment_method_types?: string[] };
    customer?: { id?: string; name?: string; phone?: string; email?: string };
    additional_info?: { override_notification_url?: string };
}

export interface DokuCheckoutResponse {
    message: string[];
    response: {
        order: { amount: string; invoice_number: string; currency: string; session_id: string };
        payment: { token_id: string; url: string; expired_date: string; payment_due_date: number };
    };
}

export const createDokuCheckoutPayment = (body: DokuCheckoutRequest) =>
    dokuRequest<DokuCheckoutResponse>('POST', '/checkout/v1/payment', body);

export interface DokuStatusResponse {
    order?: { invoice_number?: string; amount?: number; status?: string };
    transaction?: { status?: string; date?: string };
    channel?: { id?: string };
}

export const getDokuOrderStatus = (invoiceNumber: string) =>
    dokuRequest<DokuStatusResponse>('GET', `/orders/v1/status/${encodeURIComponent(invoiceNumber)}`);

/** DOKU's expired_date is yyyyMMddHHmmss in WIB (UTC+7). */
export const parseDokuExpiredDate = (value: string | undefined): Date | null => {
    const m = value?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
    if (!m) return null;
    return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+07:00`);
};
