# Rencana kerja per fase

Pecahan eksekusi dari:
- [`../plan-perbaikan-issue.md`](../plan-perbaikan-issue.md): hasil review codebase
- [`../plan-implementasi-stock-bahan-baku.md`](../plan-implementasi-stock-bahan-baku.md): implementasi [`../plan-stock-bahan-baku.md`](../plan-stock-bahan-baku.md)

Kerjakan berurutan. Setiap file fase punya checklist langkah. Langkah yang sudah dikerjakan ditandai `[x]` beserta catatan singkat. Kolom **Deploy/DB** berisi langkah yang harus dijalankan user sendiri (migration ke Supabase, SQL cek data, pembersihan Redis produksi, deploy). Claude tidak menjalankannya karena DB lokal terhubung ke data asli.

| Fase | Judul | Kode | Deploy/DB (user) |
|---|---|---|---|
| [00](./00-hapus-hampers.md) | Hapus HAMPERS | ✅ | ⏳ |
| [01](./01-validasi-input-order.md) | Validasi input order | ✅ | — |
| [02](./02-bug-kuota-redis.md) | Bug kuota Redis | ✅ | ⏳ |
| [03](./03-stock-fondasi-backend.md) | Stock A: fondasi data & backend | ✅ | ⏳ |
| [04](./04-stock-fondasi-frontend.md) | Stock B: fondasi frontend (checkpoint deploy) | ✅ | ⏳ |
| [05](./05-stock-hpp.md) | Stock C: HPP | ✅ | ⏳ |
| [06](./06-stock-auto-potong.md) | Stock D+E: auto-potong stok & verifikasi | ✅ | ⏳ |
| [07](./07-timezone-hardcode.md) | Timezone WIB & data hardcode | ✅ | ⏳ |
| [08](./08-refactor-order-route.md) | Refactor order route & idempotensi Biteship | ✅ | ⏳ |
| [09](./09-hardening.md) | Hardening ringan (tanpa auth) | ✅ | ⏳ |
| [10](./10-seragamkan-pg.md) | Seragamkan akses DB ke `pg` (+ RLS) | ✅ | ⏳ |
| [11](./11-test-dan-repo.md) | Test, kebersihan repo, pecah halaman FE | ⚠️ | — |

Legenda: ⏳ belum · 🔄 sedang · ✅ selesai · ⚠️ selesai dengan catatan

## Masih perlu keputusan / tindakan user
1. **K4:** maks rasa FULL box 2 atau 3? Seed-nya 3; bisa diubah di `/config` → kartu menu → "Maks rasa".
2. **`/pesan`** rusak sejak multi-store (semua request-nya tanpa `store_id`) dan tidak ada di Sidebar. Hapus, atau perbaiki (tambah pilihan store)?
3. **Deploy + migration** tiap fase (kolom "Deploy/DB"), termasuk script Redis (`cleanup-hampers-redis`, `resync-quotas`) dan **aktivasi RLS** (Fase 10).
4. Perubahan **belum di-commit** di kedua repo (branch `main`).

## Keputusan produk
- **K1:** cancel/edit order mengembalikan stok. ✅
- **K2:** order UNPAID tetap memotong stok sampai admin cancel. ✅
- **K3:** HAMPERS dihapus. ✅
- **K4:** maks rasa FULL box **belum diputuskan**. Sementara dibuat kolom `menu.max_flavors` yang bisa diubah admin, dengan seed FULL = 3 (mengikuti halaman publik `app/page.tsx` yang dipakai pelanggan). `/pesan` dan `/orders` sebelumnya memakai 2; sekarang ketiga halaman mengikuti kolom ini.

## Baseline sebelum mulai (2026-09-25)
- `rpn-backend`: `tsc --noEmit` bersih.
- `rpn-frontend`: `tsc --noEmit` bersih; `eslint .` ada 205 masalah (59 error, 146 warning). Target: jumlah ini tidak bertambah. (Setelah Fase 04: 199.)
- Kedua repo berada di branch `main` tanpa perubahan lokal. Perubahan dari fase-fase ini **belum di-commit**.

## Urutan deploy kalau beberapa fase dirilis sekaligus
Migration bersifat berurutan, jadi `npm run migrate up` selalu menjalankan semua yang belum jalan.
- **Fase 00–02 saja:** deploy backend + frontend → `npm run migrate up` → script Redis (`cleanup-hampers-redis`, `resync-quotas`). Backend baru tetap jalan dengan skema lama, tapi backend lama akan error kalau skema sudah baru.
- **Mulai Fase 03:** backend baru butuh tabel baru. Urutannya: (1) `npm run migrate up`, (2) **langsung** deploy backend + frontend, (3) script Redis. Selama jeda (1) ke (2), endpoint kuota di backend lama akan error karena kolom `hampers_qty` sudah hilang. Jalankan di jam sepi, dan usahakan jedanya kurang dari beberapa menit.

## Cara menjalankan test backend
- `npm test`: unit test, tanpa DB.
- `npm run test:db`: ditambah integration test ke Postgres **lokal** (default `postgres://localhost/rpn_migration_test`). Siapkan DB-nya sekali:
  ```bash
  createdb rpn_migration_test
  psql rpn_migration_test -c "CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);"
  DATABASE_URL=postgres://localhost/rpn_migration_test node node_modules/.bin/node-pg-migrate up
  ```
