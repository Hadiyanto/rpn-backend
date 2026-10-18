import { ConflictError } from '../utils/errors';
import { changeOrderStatus } from './order.service';
import { sendPushToAll } from './push.service';
import { closeStoreForOrders, type OpenOrderRow } from './store.service';

const idList = (orders: Pick<OpenOrderRow, 'id'>[]) => orders.map(o => `#${o.id}`).join(', ');

/** "Order #12, #13 masih UNPAID. Tutup toko akan mengubah status order tersebut menjadi CANCELLED." */
export const unpaidCancelMessage = (unpaid: OpenOrderRow[]) =>
    `Order ${idList(unpaid)} masih UNPAID. Tutup toko akan mengubah status order tersebut menjadi CANCELLED.`;

/**
 * Close a store for new orders (see closeStoreForOrders) and cancel the UNPAID orders the admin
 * confirmed. Cancelling goes through changeOrderStatus (quota + raw materials come back) and only
 * touches orders that are still UNPAID; one paid in the meantime is reported, not cancelled.
 * Admins get a push either way: why the store can't close yet, or what closing cancelled.
 */
export const closeStore = async (storeId: number, confirmedUnpaidIds?: number[]) => {
    const result = await closeStoreForOrders(storeId, confirmedUnpaidIds);

    if (result.outcome === 'blocked') {
        void sendPushToAll({
            title: `⚠️ ${result.store.name} belum bisa ditutup`,
            body: `Order ${idList(result.blockers)} masih PAID/CONFIRMED. Ubah ke DONE atau CANCELLED dulu.`,
            url: '/orders',
            tag: `store-close-${storeId}`,
        });
        return result;
    }
    if (result.outcome === 'confirm_unpaid') return result;

    const cancelled: OpenOrderRow[] = [];
    const notCancelled: Array<OpenOrderRow & { reason: string }> = [];
    for (const order of result.unpaidToCancel) {
        try {
            await changeOrderStatus(order.id, 'CANCELLED', { expectedStatus: 'UNPAID' });
            cancelled.push(order);
        } catch (err) {
            const reason = err instanceof ConflictError ? 'sudah tidak UNPAID (mungkin baru dibayar)' : 'gagal dibatalkan';
            if (!(err instanceof ConflictError)) console.error(`[store-close] cancel order #${order.id} failed:`, err);
            notCancelled.push({ ...order, reason });
        }
    }

    if (cancelled.length || notCancelled.length) {
        const parts = [
            cancelled.length ? `Order UNPAID ${idList(cancelled)} dibatalkan (CANCELLED).` : '',
            notCancelled.length ? `Perlu dicek: ${notCancelled.map(o => `#${o.id} ${o.reason}`).join(', ')}.` : '',
        ].filter(Boolean);
        void sendPushToAll({
            title: `🔒 ${result.store.name} ditutup`,
            body: parts.join(' '),
            url: '/orders',
            tag: `store-close-${storeId}`,
        });
    }
    return { ...result, cancelled, notCancelled };
};
