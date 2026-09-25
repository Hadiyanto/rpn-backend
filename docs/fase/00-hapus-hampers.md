# Fase 00: Hapus HAMPERS

**Status:** ✅ kode selesai · ⏳ menunggu cek data & deploy oleh user
**Tujuan:** hanya ada `box_type` FULL/HALF. Kuota hampers, menu hampers, dan UI hampers dihapus. Data order hampers lama tetap bisa dibaca (laporan dan struk).

## Langkah user sebelum deploy (Supabase SQL editor)
- [ ] Jalankan query cek data:
  ```sql
  SELECT o.status, count(*) FROM orders o JOIN order_items oi ON oi.order_id = o.id
   WHERE oi.box_type = 'HAMPERS' GROUP BY o.status;
  SELECT * FROM menu WHERE name = 'HAMPERS';
  SELECT count(*) FROM daily_quota WHERE hampers_qty > 0;
  SELECT count(*) FROM hourly_quota WHERE hampers_qty > 0;
  ```
- [ ] Order hampers yang masih aktif (UNPAID/PAID/CONFIRMED) diselesaikan atau di-cancel dulu.

## Langkah kode

### Migration
- [x] `migrations/1789842074778_remove-hampers.js`: drop `hampers_qty` dari `daily_quota` dan `hourly_quota`, lalu `UPDATE menu SET is_active = false WHERE name = 'HAMPERS'`. Constraint `order_items_box_type_check` tidak diubah. `down` mengembalikan kolom (default 0) dan mengaktifkan menu lagi.

### Backend
- [x] `services/order.service.ts`: tipe `BoxType = 'FULL' | 'HALF'`. Helper `assertValidBoxType` menolak HAMPERS ("Hampers sudah tidak tersedia") dan dipakai di `createOrder` dan `updateOrder`. Semua reservasi, rollback, dan warming kuota hampers dihapus.
- [x] `services/dailyQuota.service.ts`: `hampers_qty`, `remaining_hampers_qty`, `used_hampers_qty`, dan key `quota:hampers:*` dihapus. Signature `createDailyQuota(date, qty, store_id)` dan `updateDailyQuota(id, qty)`.
- [x] `services/hourlyQuota.service.ts`: hal yang sama. Signature `upsertHourlyQuota(time_str, qty, store_id, is_active)`.
- [x] `routes/dailyQuota.route.ts`, `routes/hourlyQuota.route.ts`: `hampers_qty` tidak lagi dibaca dari body.
- [x] `routes/order.route.ts`: helper `boxLabel()` (tipe lama tetap tampil apa adanya). Blok restore kuota legacy `quota:${pickup_date}` dihapus, beserta import `redis` yang jadi tidak terpakai.
- [x] `scripts/cleanup-hampers-redis.ts` (mendukung `--dry-run`): menghapus `quota:hampers:*`, `hourly:hampers:*`, dan key legacy `quota:YYYY-MM-DD`. Polanya dibuat persis dengan bentuk tanggal supaya key `quota:<store_id>:<date>` tidak ikut terhapus.

### Frontend
- [x] `types/menu.ts`: `export type BoxType = 'FULL' | 'HALF'`.
- [x] `utils/box.ts` (baru): `BOX_TYPES`, `boxLabel()` ("Full Box"/"Half Box"), dan `boxLabelID()` ("Box Besar"/"Box Kecil"). Tipe lama ditampilkan sebagai "Hampers".
- [x] `app/page.tsx`: tipe, label (3 tempat), cek kuota tanggal, dan `maxFlavors` FULL = 3.
- [x] `app/pesan/page.tsx`: tipe, label, tombol box memakai `BOX_TYPES`, ikon `LuGift` dihapus, cek kuota tanggal dan jam, dan `maxFlavors` FULL = 2.
- [x] `app/orders/page.tsx`: hal yang sama. Aturan khusus "Kraft" untuk hampers dihapus, karena sebelumnya hanya aktif untuk `box_type === 'HAMPERS'`. Tipe item order yang diambil dari DB tetap menerima `'HAMPERS'` untuk data lama.
- [x] `app/config/page.tsx`: state, input "Hampers Qty"/"Hmp", dan argumen `hampers_qty` di add/update/toggle kuota harian dan per jam dihapus.
- [x] `app/finance/page.tsx`: `PRICE` hanya FULL/HALF, ditambah `LEGACY_PRICE.HAMPERS = 135000` lewat `priceOf()`, supaya pendapatan historis tidak berubah dan tidak menjadi `NaN`.
- [x] `utils/printer.ts`: seksi `[ HAMPERS ]` diganti baris generik `[TIPE] nama` untuk item lama.

## Verifikasi
- [x] `grep -rni hampers` hanya menyisakan komentar dan fallback data lama (finance, printer, `utils/box.ts`, tipe order di `/orders`, serta penolakan di `order.service`).
- [x] `tsc --noEmit` backend dan frontend bersih. Lint frontend tetap 205 masalah, sama dengan baseline.
- [x] POST `/api/order` dengan HAMPERS ditolak dengan **400** "Hampers sudah tidak tersedia" (lewat `ValidationError`, Fase 01).

## Deploy (user)
- [ ] Deploy backend dan frontend **bersamaan**, lalu `npm run migrate up`.
- [ ] Jalankan `npx ts-node scripts/cleanup-hampers-redis.ts`.
- [ ] Cek `/config` (kuota harian dan per jam bisa disimpan), `/finance` periode lama, dan order baru.

## Catatan pengerjaan
- Deploy **backend dan frontend bersamaan**, lalu jalankan migration. Frontend lama masih mengirim `hampers_qty`; backend baru mengabaikannya, jadi aman. Sebaliknya, backend lama dengan DB yang sudah dimigrasi akan error karena kolomnya sudah tidak ada. Karena itu migration dijalankan **setelah** backend baru live.
- Rekomendasi urutan: (1) deploy backend, (2) deploy frontend, (3) `npm run migrate up`, (4) `npx ts-node scripts/cleanup-hampers-redis.ts --dry-run` lalu jalankan tanpa `--dry-run`.
- Menu HAMPERS dinonaktifkan (soft delete). Kalau cek data menunjukkan tidak ada order hampers sama sekali, baris menu boleh dihapus manual.
- Ditemukan (untuk Fase 07): harga `FULL: 65000 / HALF: 35000` juga di-hardcode di `rpn-backend/src/services/finance.service.ts` dan `rpn-frontend/app/finance/page.tsx`.
- Ditemukan (untuk Fase 02): `upsertHourlyQuota` hanya menulis key `hourly:base:*` yang tidak pernah dibaca. Sisa kuota per tanggal tidak ikut diperbarui saat admin mengubah qty per jam.
