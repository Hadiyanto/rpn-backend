# Fase 08: Refactor order route & idempotensi Biteship

**Status:** ✅ kode selesai · ⏳ deploy oleh user (tanpa migration)

## Langkah kode
- [x] `services/biteship.service.ts` (baru): `createBiteshipDispatch(order)`, dipindah dari route tanpa mengubah payload Biteship.
  - **Idempotensi:** sebelum memanggil Biteship, order "diklaim" secara atomik dengan `UPDATE orders SET biteship_order_id = 'PENDING' WHERE id = $1 AND biteship_order_id IS NULL`. Hanya satu pemanggil yang lolos, bahkan kalau dipanggil paralel. Kalau sukses, kolom diisi id dari Biteship. Kalau gagal atau data tidak lengkap, klaim dilepas (NULL) supaya bisa dicoba lagi.
- [x] `services/orderEvents.service.ts` (baru): `onOrderCreated` (push + WA), `onOrderStatusChanged` (WA PAID + dispatch, WA DONE), dan `onTransferUploaded` (WA). Semua handler menangkap dan me-log error-nya sendiri (`[order-events] …`).
- [x] `order.service.ts`: `changeOrderStatus(id, status)` mengembalikan `{ order, previousStatus }` dengan satu kali `getOrderById`. `updateOrderStatus` tetap ada sebagai wrapper.
- [x] `routes/order.route.ts`: **400 → 188 baris.**
  - `POST /order`: create, lalu `void onOrderCreated(data)`.
  - `PATCH /order/:id/status`: `changeOrderStatus`, lalu `getOrderById` di background, lalu `onOrderStatusChanged`.
  - `PATCH /order/:id/transfer-img-url`: `onTransferUploaded`.
  - Early `return res.json` di tengah blok Biteship ikut hilang.
- [x] `utils/boxLabel.ts` (dipindah dari route) dan `store.service.ts` `getStoreById` memakai `pg`, dengan bentuk yang sama.
- [x] ~~Migration `…_add-biteship-order-id-to-orders.js`~~: **tidak diperlukan**, karena kolom `orders.biteship_order_id` sudah dibuat oleh `1772650100000_add-delivery-columns-to-orders.js` tapi belum pernah diisi oleh kode.

## Verifikasi
- [x] Integration test `src/services/__tests__/orderEvents.integration.test.ts` (4 test; WhatsApp, Biteship, dan push di-mock):
  - PAID → tepat 1 dispatch, `biteship_order_id = 'bs-123'` tersimpan, `delivery_type: 'now'` untuk tanggal hari ini (WIB), dan `value` item diambil dari harga menu.
  - PAID → UNPAID → PAID → tetap 1 dispatch.
  - 5 dispatch paralel → 1 shipment.
  - Biteship gagal → klaim dilepas; percobaan berikutnya berhasil.
  - WA hanya terkirim saat status benar-benar berubah (PAID → PAID tidak mengirim apa-apa). Order pickup tidak pernah di-dispatch.
- [x] `npm run test:db`: **90 test lulus**; `tsc --noEmit` bersih.

## Deploy (user)
- [ ] Deploy backend. Tes satu order delivery sampai PAID, lalu cek `SELECT id, biteship_order_id FROM orders WHERE delivery_method = 'store_delivery' ORDER BY id DESC LIMIT 5;`.

## Catatan pengerjaan
- **Perubahan perilaku:**
  - WA dan Biteship sekarang hanya jalan saat status **berubah**. Dulu, men-set PAID ke order yang sudah PAID mengirim WA lagi dan membuat shipment kedua.
  - WA dan Biteship dijalankan di background, sehingga response `PATCH /status` lebih cepat dan tidak lagi menunggu Biteship.
- Order yang sudah PAID sebelum deploy memiliki `biteship_order_id = NULL`. Kalau statusnya diubah bolak-balik ke PAID, sistem akan membuat shipment (sama seperti perilaku lama). Kalau perlu, tandai order lama yang sudah dikirim secara manual: `UPDATE orders SET biteship_order_id = 'LEGACY' WHERE delivery_method = 'store_delivery' AND status IN ('PAID','CONFIRMED','DONE') AND biteship_order_id IS NULL;`
- Kalau Biteship berhasil membuat order tapi response-nya tidak memuat `id`, kolom diisi `'UNKNOWN'` supaya tetap tidak terjadi dispatch ganda.
