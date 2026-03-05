/**
 * WhatsApp message templates for order events.
 * All functions return the message string ready to send.
 */

export function buildNewOrderMessage(params: {
    customer_name: string;
    order_id: number;
    order_details: string;
    total_box: number;
    total_amount: string;
    upload_link: string;
}): string {
    const { customer_name, order_details, total_box, total_amount, upload_link } = params;
    return (
        `Hai ${customer_name}, pesanannya sudah diterima ya.\n\n` +
        `Detail Pesanan:\n${order_details}\n\n` +
        `Jumlah: ${total_box} box\n` +
        `Total: Rp ${total_amount}\n\n` +
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
}): string {
    const { customer_name, order_id, scheduleDate } = params;
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

export function buildTransferReceivedMessage(customer_name: string): string {
    return `Hai ${customer_name}\nBukti pembayarannya kita validasi dulu ya`;
}
