/**
 * WhatsApp message templates for order events.
 * All functions return the message string ready to send.
 */

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

export function buildNewOrderMessage(params: {
    customer_name: string;
    order_id: number;
    order_details: string;
    total_box: number;
    total_amount: string;
    upload_link: string;
    /** DOKU checkout link (DOKU_PAYMENT=true): replaces the bank account + upload instructions. */
    payment_link?: string | null;
    /** Store delivery: courier + address + when it ships. */
    delivery?: (DeliveryInfo & { schedule: string }) | null;
}): string {
    const { customer_name, order_details, total_box, total_amount, upload_link, payment_link, delivery } = params;
    const header =
        `Hai ${customer_name}, pesanannya sudah diterima ya.\n\n` +
        `Detail Pesanan:\n${order_details}\n\n` +
        `Jumlah: ${total_box} box\n` +
        `Total: Rp ${total_amount}\n\n` +
        (delivery
            ? `🛵 Dikirim oleh toko via ${delivery.courier}\n` +
              `📍 Alamat: ${delivery.address}\n` +
              `🗓️ Jadwal kirim: ${delivery.schedule}\n\n`
            : '');
    if (payment_link) {
        return (
            header +
            `Silakan selesaikan pembayaran melalui link berikut:\n${payment_link}\n\n` +
            `Status pesanan bisa dicek di:\n${upload_link}\n\n` +
            `Terima kasih,\nRaja Pisang Nugget`
        );
    }
    return (
        header +
        `Pembayaran bisa melalui:\n` +
        `Bank: BCA\nNo Rek: 1280119748\nA/N: Anggita Prima\n\n` +
        `Mohon konfirmasi bukti pembayarannya melalui link berikut:\n${upload_link}\n\n` +
        `Terima kasih,\nRaja Pisang Nugget`
    );
}

export function buildPaidOrderMessage(params: {
    customer_name: string;
    order_id: number;
    scheduleDate: string;
    /** Store delivery: no pickup instructions — the store sends a courier. */
    delivery?: DeliveryInfo | null;
}): string {
    const { customer_name, order_id, scheduleDate, delivery } = params;
    if (delivery) {
        return (
            `Hi ${customer_name} 🙌🏻\n\n` +
            `Pembayaran untuk pesanan *#${order_id}* sudah kami terima, makasih ya!\n\n` +
            `Pesananmu akan kami kirim sesuai jadwal *${scheduleDate}*.\n\n` +
            `🛵 Kurir: ${delivery.courier}\n` +
            `📍 Alamat: ${delivery.address}\n\n` +
            `Kurir kami pesan saat pesanan sudah siap, nanti kami kirimkan link untuk lacak pengirimannya ya! 😊\n` +
            `Raja Pisang Nugget`
        );
    }
    return (
        `Hi ${customer_name} 🙌🏻\n\n` +
        `Pembayaran untuk pesanan *#${order_id}* sudah kami terima, makasih ya!\n\n` +
        `Pesananmu akan kami proses sesuai jadwal *${scheduleDate}*.\n\n` +
        `Untuk pengambilan nanti bisa via:\n` +
        `🛵 GoSend\n🛵 GrabExpress\n🛵 Maxim (opsional kalau tersedia di area kamu)\n\n` +
        `Atau pick up langsung ke:\n` +
        `Raja Pisang Nugget Kalibata\nTaman Kanak Kanak Widyastuti\n` +
        `Jl. Rawajati Timur VIII, Rawajati, Pancoran\nJakarta Selatan 12750\n\n` +
        `📍 Google Maps:\nhttps://maps.app.goo.gl/633auSZ14ucptMDS7\n\n` +
        `*Notes untuk driver:*\n*Ambil pesanan Pisang Nugget*\nAtas nama ${customer_name}\n\n` +
        `Nanti kami kabarin lagi kalau sudah siap diambil ya! 😊\nRaja Pisang Nugget`
    );
}

export function buildDoneOrderMessage(params: {
    customer_name: string;
    order_id: number;
}): string {
    const { customer_name, order_id } = params;
    return (
        `Hi ${customer_name}! 🎉\n\n` +
        `Pesanan *#${order_id}* kamu sudah selesai dibuat dan *siap diambil sekarang*!\n\n` +
        `Silakan atur pickup ya. Terima kasih sudah order! 🍌\nRaja Pisang Nugget`
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
        `Terima kasih sudah order! 🍌\nRaja Pisang Nugget`
    );
}

export function buildTransferReceivedMessage(customer_name: string): string {
    return `Hai ${customer_name}\nBukti pembayarannya kita validasi dulu ya`;
}
