/**
 * Normalizes a phone number to WhatsApp format (62xxx)
 */
export function formatWAPhone(phone: string): string {
    let p = phone.replace(/[^0-9]/g, '');
    if (p.startsWith('0')) p = '62' + p.substring(1);
    return p;
}
