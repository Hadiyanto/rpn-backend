# Fase 01: Validasi input order

**Status:** ✅ kode selesai (tidak butuh migration; ikut deploy backend berikutnya)
**Tujuan:** payload order yang tidak valid ditolak dengan 400 sebelum menyentuh Redis atau DB. Contoh kasus: qty negatif yang justru *menambah* kuota.

## Langkah kode
- [x] `src/utils/validation.ts` (baru):
  - Kelas `ValidationError` (status 400).
  - `assertValidBoxType`, dipindahkan dari `order.service`. HAMPERS ditolak dengan pesan khusus.
  - `validateOrderItems`: array 1–20 item; `qty` integer 1–50; nama di-trim, 1–255 karakter.
  - `validatePickupDate`: format dan tanggal nyata (menolak `2026-02-30`), tidak di masa lalu menurut WIB (`todayWIB()`), dengan opsi `allowPast`.
  - `validatePickupTime`: `HH:mm` atau `HH:mm - HH:mm`; kosong berarti tidak diisi.
  - `validatePhone`: 9–15 digit setelah `formatWAPhone`. Nilai asli tetap yang disimpan.
  - `validateCustomerName`, `validateNote` (maks 1000 karakter), `validateStoreId`.
- [x] `createOrder`: semua field divalidasi **sebelum** menyentuh Redis. Nama pelanggan dan nama rasa yang disimpan sudah di-trim.
- [x] `updateOrder`: field yang dikirim ikut divalidasi. Tanggal lama yang sudah lewat tetap boleh dipertahankan saat edit (`allowPast` hanya kalau tanggalnya sama dengan sebelumnya). `pickup_time: null` tetap bisa mengosongkan jam.
- [x] Route `POST /order` dan `PATCH /order/:id` mengembalikan **400** untuk `ValidationError`. Order HAMPERS sekarang juga mendapat 400.

## Verifikasi
- [x] `vitest` dipasang sebagai devDependency dan script `npm test` ditambahkan. `src/utils/__tests__/validation.test.ts`: **33 test lulus**, termasuk qty −100, 0, 1.5, 51, dan `"2"`; tanggal 30 Februari; serta batas pergantian hari WIB vs UTC.
- [x] `tsc --noEmit` bersih. Folder `src/**/__tests__` di-exclude dari `tsconfig` supaya tidak ikut ter-build ke `dist/`.

## Catatan pengerjaan
- **Perubahan perilaku:** order baru (dari publik maupun `/pesan`) dengan tanggal sebelum hari ini (WIB) sekarang ditolak. Sebelumnya diterima.
- **Perubahan perilaku:** qty per item maksimal 50 dan maksimal 20 item per order. Ubah `MAX_ITEM_QTY` / `MAX_ORDER_ITEMS` di `validation.ts` kalau ada pesanan besar.
- Error bisnis lain (misalnya kuota penuh) masih dikembalikan sebagai 500 dengan pesan yang jelas. Ini dirapikan di Fase 09 (error handler terpusat).
