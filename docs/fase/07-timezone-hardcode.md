# Fase 07: Timezone WIB & data hardcode

**Status:** ✅ kode selesai · ⏳ migrate + deploy oleh user

## Langkah kode

### Backend
- [x] `src/utils/date.ts` (baru):
  - `todayWIB()` (dipindah dari `validation.ts`, yang kini me-re-export).
  - `dayOfWeek(date)` dan `formatDateID(date)`: keduanya menghitung dari tanggal kalender (jam 12:00 UTC), jadi tidak bergantung pada timezone server.
- [x] `order.route.ts`:
  - Tanggal di push notification, WA order baru, dan WA PAID memakai `formatDateID`.
  - `isToday` Biteship = `pickup_date === todayWIB()`. Sebelumnya, antara 00:00 dan 07:00 WIB order untuk hari ini dikirim sebagai *scheduled*, padahal seharusnya *now*.
- [x] `order.service.ts` `getOrders`: filter `ov` yang tidak berfungsi dihapus; filter hari memakai `dayOfWeek`. Sebelumnya bergeser 1 hari di server UTC.
- [x] `menu.service.ts` `getMenuPriceMap({ activeOnly })`:
  - Dipakai untuk total harga di WA dan `value` item Biteship (menggantikan hardcode 50000).
  - Dipakai juga di `finance.service.ts`, menggantikan hardcode 65000/35000. Di sini `activeOnly: false`, supaya HAMPERS yang sudah dinonaktifkan tetap terhitung untuk order lama.
- [x] Migration `1789842083778_add-bank-to-stores.js`: `bank_name`, `bank_account_number`, `bank_account_name`. Semua store diisi dengan rekening yang sebelumnya di-hardcode (BCA 1280119748 a.n. Anggita Prima). Diuji di DB lokal.
- [x] `store.service.ts` dan `store.route.ts`: `PUT /stores/:id` menerima ketiga field bank.

### Frontend
- [x] `app/page.tsx`:
  - Rekening transfer diambil dari `selectedStore`. Kalau belum diisi, muncul teks "Nomor rekening akan dikirim admin via WhatsApp".
  - `value` item untuk cek ongkir memakai harga menu.
- [x] `app/bukti-transfer/[id]/page.tsx`: rekening diambil dari store milik order (`GET /stores/:store_id`).
- [x] `app/finance/page.tsx`: harga dari `GET /api/menu` (termasuk menu nonaktif). `PRICE` dan `LEGACY_PRICE` hardcode dihapus. Loading menunggu harga termuat.
- [x] `app/config/page.tsx`: form "Kelola Store" punya field Bank, No. Rekening, dan Atas Nama.
- [x] `app/shipping/page.tsx`: **perbaikan bug.**
  - Request ongkir dan pembuatan order Biteship sebelumnya tidak mengirim `store_id`, dan request ongkir juga tidak mengirim koordinat tujuan, padahal backend mewajibkan keduanya (400). Artinya halaman ini tidak bisa dipakai sejak versi multi-store.
  - Sekarang ada pilihan store (muncul kalau store lebih dari satu), dan payload mengirim `store_id` + `destination_latitude/longitude`.
  - Konstanta origin hardcode (termasuk nomor telepon `08561234567`) dihapus; origin diambil dari data store oleh backend.
- [x] `utils/config.ts` sekarang hanya berisi `API_URL`. `ORIGIN_AREA_ID`, `STORE_NAME`, dan `BCA_ACCOUNT_*` dihapus.

## Verifikasi
- [x] `src/utils/__tests__/date.test.ts` (3 test): 23:30 UTC = besok di WIB; hari dari tanggal; "Senin, 2 Maret 2026".
- [x] Integration test `getMenuPriceMap` (aktif saja vs semua termasuk HAMPERS).
- [x] `npm run test:db`: **86 test lulus**, juga lulus di `TZ=UTC` (seperti Render) dan `TZ=Asia/Jakarta`.
- [x] Frontend: `tsc` bersih; lint **197**; `npm run build` sukses (`sw.js` dikembalikan).

## Deploy (user)
- [ ] `npm run migrate up` dan deploy backend + frontend.
- [ ] Cek rekening di `/config` → Kelola Store (untuk store 2 kalau rekeningnya berbeda), di halaman sukses order TRANSFER, dan di halaman bukti transfer.
- [ ] Coba `/shipping`: pilih store, cek tarif, lalu buat pengiriman.

## Catatan pengerjaan
- ⚠️ **Temuan, perlu keputusan:** `/pesan` juga **rusak sejak multi-store**. Halaman ini memanggil `/api/daily-quota`, `/api/hourly-quota/availability`, `/api/biteship/rates`, dan `POST /api/order` **tanpa `store_id`**, dan keempat endpoint itu menolak dengan 400. Halaman ini juga tidak ada di Sidebar. Belum diperbaiki di fase ini. Pilihannya: hapus halaman, atau tambahkan pilihan store (sekitar ½ hari).
- Harga di laporan finance memakai harga menu **saat ini**, bukan harga saat order dibuat. Perilakunya sama dengan sebelumnya (dulu juga harga hardcode saat ini). Kalau butuh harga historis, simpan `unit_price` di `order_items` (belum di-scope).
- `finance.service` `totalBoxes` menghitung HALF sebagai 1 box (jumlah fisik box). Tidak diubah karena kemungkinan memang disengaja.
