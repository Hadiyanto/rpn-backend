# Fase 06: Stock D+E, auto-potong stok & verifikasi

**Status:** ✅ kode selesai · ⏳ deploy + verifikasi manual oleh user
**Referensi:** [design doc](../plan-stock-bahan-baku.md) Fitur 3 · keputusan K1 (reversal saat cancel/edit) dan K2 (UNPAID tetap terpotong)

## Backend
- [x] `services/stockDeduction.service.ts` (baru):
  - **Prinsip:** setiap mutasi otomatis dicatat di `stock_history` dengan `order_id`. Efek bersih sebuah order terhadap tiap bahan selalu sama dengan `SUM(qty_change)` untuk order itu. Semua operasi mengunci baris order (`SELECT … FOR UPDATE`), sehingga potong dan reversal untuk order yang sama berjalan berurutan.
  - `applyOrderStock(orderId)`:
    - Dilewati kalau order CANCELLED, tidak punya store, atau net-nya ≠ 0 (sudah dipotong). Ini yang membuatnya idempotent.
    - Kalau tidak, untuk tiap item yang punya `variant_ids`: `resolveBoxCost(…, client) × qty`, dijumlahkan per bahan (`aggregateDeductions`, dibulatkan 2 desimal sesuai presisi `stock_history`), lalu `UPDATE stock SET qty = qty − x` dan dicatat sebagai OUT "Order #id".
  - `reverseOrderStock(orderId)`: mengembalikan net potongan per bahan sebagai IN "Reversal Order #id".
  - `applyOrderStockSafe` / `reverseOrderStockSafe`: **tidak pernah throw**. Error di-log dengan prefix `[stock] … failed for order #id`, dan mutasi yang berhasil di-log sebagai `[stock] apply/reverse order #id: …`.
  - `recalculateOrderStock(orderId)`: reverse, lalu apply.
- [x] Pemicu (semuanya dijalankan **setelah** commit order dan di-`await` dalam versi `Safe`, jadi deterministik tapi tidak bisa menggagalkan order):
  - `createOrder` → apply (termasuk order UNPAID; K2).
  - `updateOrderStatus`:
    - Berubah ke CANCELLED → reverse. Dari CANCELLED ke status lain → apply (K1).
    - Fungsi ini sekarang memakai `pg`, bukan supabase-js; bentuk response sama.
  - `updateOrder` dengan `pesanan` baru → reverse lalu apply (K1). Order yang sedang CANCELLED tidak dipotong.
- [x] Endpoint `POST /order/:id/recalculate-stock` untuk retry manual atau setelah resep diperbaiki. Aman dipanggil berulang. Nama endpoint diganti dari rencana awal `reapply-stock`, karena endpoint ini sekaligus mengoreksi selisih.

## Verifikasi
- [x] Unit test `aggregateDeductions` (3 test).
- [x] Integration test `src/services/__tests__/stockDeduction.integration.test.ts` (9 test; Postgres lokal + Redis palsu). Skenario verifikasi dari design doc, **otomatis**:
  - Resep Dark Choco = 50 g Tepung; stok masuk 5000 g seharga Rp 700.000.
  - 2× FULL Dark Choco → **4900 g**, `stock_history` OUT dengan `order_id` ✅
  - FULL Mix Dark Choco + Vanilla → **−25 g**; HALF Dark Choco → **−25 g** ✅
  - Cancel → +100; cancel lagi → tidak berubah; un-cancel → −100; UNPAID → PAID → tidak berubah ✅
  - Edit qty 2 → 5 → total −250; edit order yang CANCELLED → tidak dipotong ✅
  - Stok 30 g, lalu order 50 g → stok **−20**, order tetap sukses ✅
  - `applyOrderStock` kedua kali → "already applied"; resep diubah lalu `recalculate` → selisihnya terkoreksi ✅
  - 5 reverse paralel dan 5 apply paralel → hanya berefek sekali ✅
  - Item lama tanpa `variant_ids` tidak dipotong ✅
  - Tabel resep sengaja dirusak → order **tetap tersimpan**, error `[stock] apply failed` tercatat, stok tidak berubah ✅
- [x] `npm run test:db`: **82 test lulus**; `tsc --noEmit` bersih.

## Deploy & verifikasi manual (user, lewat UI)
- [ ] Deploy backend (tidak ada migration baru di fase ini; tabel dan kolomnya sudah ada sejak Fase 03 dan 05).
- [ ] Lakukan skenario di atas sekali lewat UI dengan data test, lalu cek `/stock/[id]/history`.
- [ ] Pantau log Render dengan filter `[stock]` beberapa hari pertama.

## Catatan pengerjaan
- Order yang dibuat **sebelum** Fase 04 tidak punya `variant_ids`, jadi tidak pernah dipotong dan tidak bisa di-reverse. Ini sesuai G7. Kalau order lama seperti itu diedit lewat `/orders`, frontend akan mencocokkan nama rasa ke `variant_ids`, dan sejak itu order tersebut ikut dipotong.
- Stok dipotong dengan resep yang berlaku saat order dibuat. Kalau resep berubah, order lama tidak ikut berubah kecuali dipanggil `recalculate-stock` atau diedit.
