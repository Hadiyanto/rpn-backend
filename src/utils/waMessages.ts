/**
 * WhatsApp message templates for order events.
 * All functions return the message string ready to send. Store details (name, address, Maps link,
 * bank account) come from the order's store — never hardcoded.
 */

/** Brand name in the sign-off (BRAND_NAME env). */
export const brandName = () => process.env.BRAND_NAME || 'Raja Pisang Nugget';

/** The order's store, as shown to the customer. */
export interface StoreInfo {
    name: string;
    address: string | null;
    /** stores.maps_url, or a Google Maps link built from the store's coordinates. */
    maps_url: string | null;
    bank: { name: string | null; number: string; holder: string | null } | null;
    has_qris: boolean;
}

/** Store delivery details shown to the customer (store-delivery orders only). */
export interface DeliveryInfo {
    courier: string;   // e.g. "Lalamove Motorcycle"
    address: string;
}

const COURIER_NAMES: Record<string, string> = { grab: 'Grab', gojek: 'Gojek', lalamove: 'Lalamove' };
const titleCase = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/** "Lalamove Motorcycle", "Grab Instant" — orders from before courier choice were booked as Grab Instant. */
export const courierLabel = (company?: string | null, type?: string | null) =>
    `${COURIER_NAMES[company || 'grab'] ?? titleCase(company || 'grab')} ${titleCase(type || 'instant')}`;

/** Store name + address + Maps link, one per line (missing parts left out). */
const storeBlock = (store: StoreInfo) =>
    [store.name, store.address, store.maps_url ? `📍 Google Maps:\n${store.maps_url}` : null].filter(Boolean).join('\n');

/** How to pay, by payment method; `statusLink` is the order's status page (transfer proof upload there). */
const paymentBlock = (paymentMethod: string | null | undefined, store: StoreInfo, statusLink: string, paymentLink?: string | null) => {
    if (paymentLink) {
        return `Silakan selesaikan pembayaran melalui link berikut:\n${paymentLink}\n\n` +
            `Status pesanan bisa dicek di:\n${statusLink}`;
    }
    switch (paymentMethod) {
        case 'TRANSFER':
            return (store.bank
                ? `Pembayaran via transfer ke:\n` +
                  `Bank: ${store.bank.name ?? '-'}\nNo Rek: ${store.bank.number}\nA/N: ${store.bank.holder ?? '-'}\n\n`
                : `Nomor rekening akan kami kirim lewat WhatsApp.\n\n`) +
                `Setelah transfer, upload bukti pembayarannya di link berikut:\n${statusLink}`;
        case 'QRIS':
            return `Silakan bayar dengan scan QRIS di link berikut, lalu upload bukti pembayarannya:\n${statusLink}`;
        case 'CASH':
            return `Pembayaran tunai saat pengambilan.\n\nStatus pesanan bisa dicek di:\n${statusLink}`;
        default:
            return `Status pesanan bisa dicek di:\n${statusLink}`;
    }
};

export function buildNewOrderMessage(params: {
    customer_name: string;
    order_id: number;
    order_details: string;
    total_box: number;
    total_amount: string;
    /** The order's status page (/status/<token>): payment status, transfer proof upload. */
    status_link: string;
    payment_method?: string | null;
    store: StoreInfo;
    /** DOKU checkout link (DOKU_PAYMENT=true): replaces the other payment instructions. */
    payment_link?: string | null;
    /** Store delivery: courier + address + when it ships. */
    delivery?: (DeliveryInfo & { schedule: string }) | null;
}): string {
    const { customer_name, order_details, total_box, total_amount, status_link, payment_method, store, payment_link, delivery } = params;
    return (
        `Hai ${customer_name}, pesanannya sudah diterima ya.\n\n` +
        `Detail Pesanan:\n${order_details}\n\n` +
        `Jumlah: ${total_box} box\n` +
        `Total: Rp ${total_amount}\n\n` +
        (delivery
            ? `🛵 Dikirim oleh ${store.name} via ${delivery.courier}\n` +
              `📍 Alamat: ${delivery.address}\n` +
              `🗓️ Jadwal kirim: ${delivery.schedule}\n\n`
            : `🏪 Store: ${store.name}\n\n`) +
        paymentBlock(payment_method, store, status_link, payment_link) + `\n\n` +
        `Terima kasih,\n${brandName()}`
    );
}

export function buildPaidOrderMessage(params: {
    customer_name: string;
    order_id: number;
    scheduleDate: string;
    store: StoreInfo;
    /** Store delivery: no pickup instructions — the store sends a courier. */
    delivery?: DeliveryInfo | null;
}): string {
    const { customer_name, order_id, scheduleDate, store, delivery } = params;
    if (delivery) {
        return (
            `Hi ${customer_name} 🙌🏻\n\n` +
            `Pembayaran untuk pesanan *#${order_id}* sudah kami terima, makasih ya!\n\n` +
            `Pesananmu akan kami kirim sesuai jadwal *${scheduleDate}*.\n\n` +
            `🛵 Kurir: ${delivery.courier}\n` +
            `📍 Alamat: ${delivery.address}\n\n` +
            `Kurir kami pesan saat pesanan sudah siap, nanti kami kirimkan link untuk lacak pengirimannya ya! 😊\n` +
            brandName()
        );
    }
    return (
        `Hi ${customer_name} 🙌🏻\n\n` +
        `Pembayaran untuk pesanan *#${order_id}* sudah kami terima, makasih ya!\n\n` +
        `Pesananmu akan kami proses sesuai jadwal *${scheduleDate}*.\n\n` +
        `Untuk pengambilan nanti bisa via:\n` +
        `🛵 GoSend\n🛵 GrabExpress\n🛵 Maxim (opsional kalau tersedia di area kamu)\n\n` +
        `Atau pick up langsung ke:\n` +
        `${storeBlock(store)}\n\n` +
        `*Notes untuk driver:*\n*Ambil pesanan Pisang Nugget*\nAtas nama ${customer_name}\n\n` +
        `Nanti kami kabarin lagi kalau sudah siap diambil ya! 😊\n${brandName()}`
    );
}

export function buildDoneOrderMessage(params: {
    customer_name: string;
    order_id: number;
    store: StoreInfo;
}): string {
    const { customer_name, order_id, store } = params;
    return (
        `Hi ${customer_name}! 🎉\n\n` +
        `Pesanan *#${order_id}* kamu sudah selesai dibuat dan *siap diambil sekarang* di ${store.name}!\n\n` +
        (store.maps_url ? `📍 ${store.maps_url}\n\n` : '') +
        `Silakan atur pickup ya. Terima kasih sudah order! 🍌\n${brandName()}`
    );
}

/** Store delivery, order DONE: the courier is booked — with the tracking link when there is one. */
export function buildDeliveryDispatchedMessage(params: {
    customer_name: string;
    order_id: number;
    courier: string;
    tracking_link?: string | null;
}): string {
    const { customer_name, order_id, courier, tracking_link } = params;
    return (
        `Hi ${customer_name}! 🎉\n\n` +
        (tracking_link
            ? `Pesanan *#${order_id}* kamu sudah siap dan sedang dikirim dengan *${courier}*.\n\n` +
              `📦 Lacak pengiriman:\n${tracking_link}\n\n`
            : `Pesanan *#${order_id}* kamu sudah siap dan akan segera kami kirim dengan *${courier}*.\n\n`) +
        `Terima kasih sudah order! 🍌\n${brandName()}`
    );
}

export function buildTransferReceivedMessage(customer_name: string): string {
    return `Hai ${customer_name}\nBukti pembayarannya kita validasi dulu ya`;
}
