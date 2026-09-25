# Fase 09: Hardening ringan (tanpa auth)

**Status:** ✅ kode selesai · ⏳ migrate + deploy oleh user

## Langkah kode
- [x] **Rate limit** (`src/index.ts`): endpoint polling (GET orders, menu, variants, kuota, WA status/QR) tidak lagi di-skip total. Sekarang ada 2 limiter dengan counter terpisah: umum 60 request/menit dan polling 300 request/menit per IP. Pesan 429-nya dalam bahasa Indonesia, dengan header `RateLimit-*` standar.
- [x] **Error terpusat** (`src/utils/errors.ts`):
  - Kelas `AppError(status)`, `NotFoundError` (404), `ConflictError` (409), `UpstreamError` (502). `ValidationError` (400) sekarang turunan `AppError`.
  - `sendError(res, err)`: `AppError` diteruskan apa adanya (status + pesan). Error lain di-log lengkap, lalu dijawab 500 "Terjadi kesalahan server. Silakan coba lagi.", supaya detail DB/driver tidak bocor ke client.
  - Error bisnis di service diberi tipe:
    - Kuota harian penuh, kuota jam penuh, dan toko belum buka → **409**.
    - "Order/Store/Debt/Capital … tidak ditemukan" → **404**. `GET /order/:id` untuk id yang tidak ada sekarang 404; dulu 500.
    - Status tidak valid → 400.
    - Error dari Biteship → 502, pesannya tetap ditampilkan ke admin.
  - **Sekitar 70 `catch`** di `src/routes/*.ts` diganti dengan `sendError`.
  - Error handler global Express di akhir `index.ts`: JSON body rusak → 400 "Body JSON tidak valid"; sisanya lewat `sendError`.
- [x] **Pool DB** (`config/db.ts`): `max: 100` → `Number(process.env.PG_POOL_MAX) || 10`.
- [x] **Upload** (`upload.route.ts`):
  - Batas 5 MB (pesan 400 "Ukuran gambar maksimal 5 MB") dan 1 file.
  - Hanya `image/*`; file lain → 400.
  - File temp dihapus di `finally` dengan `fs.promises.unlink`. Dulu tertinggal kalau Cloudinary gagal.
- [x] **Token publik order:**
  - Migration `1789842084778_add-public-token-to-orders.js`: `public_token uuid NOT NULL DEFAULT gen_random_uuid()`, unique. Setiap order lama otomatis mendapat token unik. Diuji di DB lokal.
  - `GET /order/public/:token` hanya mengembalikan field untuk halaman bukti transfer (id, nama, tanggal/jam, status, metode bayar, store, `has_transfer_img`, items), **tanpa** nomor HP, alamat, dan koordinat.
  - `PATCH /order/public/:token/transfer-img-url`.
  - Link WA "upload bukti transfer" sekarang `/bukti-transfer/<public_token>`.
  - URL bukti transfer (di endpoint publik maupun endpoint lama) harus `https://res.cloudinary.com/…`, jadi URL sembarang tidak bisa disimpan.
  - Frontend `app/bukti-transfer/[id]/page.tsx`: kalau parameter berbentuk UUID, pakai endpoint publik; kalau angka (link lama), pakai endpoint lama. Link lama tetap berfungsi selama masa transisi.
- [x] **Tambahan frontend:** `/orders` sekarang menampilkan pesan error dari backend (validasi, kuota penuh, dll.) saat simpan order atau ubah status. Dulu selalu muncul "Gagal submit order" / "Gagal update status".

## Verifikasi
- [x] `src/utils/__tests__/errors.test.ts` (4 test): 400/404/409 diteruskan, error internal disembunyikan dan di-log.
- [x] Integration test: `public_token` berformat UUID; tampilan publik tanpa HP/alamat; token tidak dikenal atau berupa id angka → 404; URL non-Cloudinary ditolak; kuota penuh → 409; order tidak ada → 404.
- [x] `npm run test:db`: **96 test lulus**. Backend `tsc` bersih. Frontend `tsc` bersih, lint 197, build sukses.
- [ ] Belum diuji lewat HTTP sungguhan (rate limit, upload, error handler global). `src/index.ts` langsung `listen` dan menghubungkan WhatsApp ke Redis produksi saat di-import, jadi tidak dijalankan dari test. Uji manual setelah deploy.

## Deploy (user)
- [ ] `npm run migrate up` dan deploy backend + frontend.
- [ ] Buat order dengan HP sendiri, buka link WA (harus berupa UUID), lalu upload bukti transfer.
- [ ] Coba upload file lebih dari 5 MB atau file PDF di halaman bukti transfer: harus muncul pesan yang jelas.
- [ ] Opsional: set env `PG_POOL_MAX` di Render kalau butuh selain 10.

## Catatan pengerjaan
- **Perubahan perilaku:** error tak terduga sekarang tampil sebagai "Terjadi kesalahan server. Silakan coba lagi." (detailnya ada di log Render dengan prefix `[error]`). Pesan bisnis tetap tampil seperti biasa.
- `GET /order/:id` berbasis id (dipakai admin dan link lama) masih mengembalikan data lengkap. Menutupnya butuh auth (ditunda sesuai keputusan).
