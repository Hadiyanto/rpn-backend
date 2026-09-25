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
2. ~~`/pesan`~~ **dihapus.** Halaman ini memang sudah di-redirect ke `/` lewat `next.config.js`, dan redirect-nya dipertahankan untuk link lama.
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

## Pembersihan data produksi (dijalankan 2026-09-25)
Atas permintaan user, **semua data operasional dan master (kecuali store dan user) sudah dikosongkan di produksi**, supaya setup bisa dimulai dari nol.
- **Backup (terverifikasi):** `rpn-backend/backups/rpn-before-clear-<waktu>.dump` (pg_dump, schema public; sudah dicoba di-restore ke DB lokal dan jumlah barisnya cocok) dan CSV per tabel di `rpn-backend/backups/2026-09-25T14-51-12/`. Folder ini gitignored, jadi **salin ke tempat aman**.
- **Dikosongkan** (satu transaksi, tanpa CASCADE, tanpa RESTART IDENTITY):
  - orders (233), order_items (377)
  - variant (20), menu (3)
  - stock (15), stock_history (9)
  - pengeluaran (40), salary_config (5), daily_salary (3)
  - daily_quota (11), hourly_quota (6)
  - Ikut dikosongkan karena FK (semuanya 0 baris): order_item_variants, variant_recipe, variant_components.
- **Dipertahankan:** stores (2), user_roles (3), push_subscriptions (1), capital (0), debt (0), health, pgmigrations.
- **Redis:** cache `menu_list` / `variant_list` dihapus (`scripts/clear-quota-redis.ts --caches`). Tidak ada counter kuota yang tersisa. Sesi WhatsApp tidak disentuh.
- **Temuan:** tabel `penjualan` dan `transactions` **tidak ada** di produksi, walaupun dibuat di migration awal, jadi endpoint POS (`/transactions`, `/penjualan`) akan error di produksi. Semua migration sampai `1789842084778` sudah tercatat jalan.
- Langkah "cleanup-hampers-redis" dan "resync-quotas" di fase 00/02 **tidak diperlukan lagi**. `cleanup-hampers-redis.ts` sudah dihapus karena polanya tanpa namespace dan berbahaya di instance Redis bersama.
- **Restore darurat:** `pg_restore -d "$DATABASE_URL" --data-only --no-owner <file.dump>` (ke tabel yang sudah kosong).

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


## Penamaan key Redis (2026-09-26)
- Hasil scan produksi (hanya membaca): Redis **dipakai bersama aplikasi lain** (`resident:*` 43 key, `testdoc:*` 1 key). Key RPN yang ada hanya sesi WhatsApp (`rpn-wa-session:*`, 9 key). Tidak ada key kuota atau cache, sesuai DB yang sudah dikosongkan.
- Semua key RPN kini di bawah namespace **`rpn:`** dan dibangun di `src/utils/redisKeys.ts`:
  - `rpn:quota:daily:{store}:{tanggal}` (dulu `quota:{store}:{tanggal}`)
  - `rpn:quota:hourly:{store}:{tanggal}:{HH}` (dulu `hourly:{store}:{tanggal}:{HH:00}`)
  - `rpn:cache:menu:v1` (dulu `menu_list:v3`), `rpn:cache:variants:v1` (dulu `variant_list:v4`)
  - `rpn:wa:main:{jenis}` (dulu `rpn-wa-session:{jenis}`)
- **Sesi WhatsApp tidak ter-logout:** saat backend baru pertama menyala, key `rpn-wa-session:*` dipindah ke `rpn:wa:main:*` dengan `RENAMENX` (atomik, tidak menimpa, aman dijalankan ulang). `KEYS` diganti `SCAN`.
- Script: `clear-quota-redis.ts` hanya menyentuh `rpn:quota:*` / `rpn:cache:*`. `cleanup-hampers-redis.ts` dihapus.
- Test: **120 lulus** (termasuk unit test nama key dan test migrasi sesi WA dengan Redis palsu: key aplikasi lain tidak tersentuh, key basi tidak menimpa yang baru).
- **Saat deploy:** Render menjalankan instance lama dan baru bersamaan sebentar. Instance lama masih menulis ke `rpn-wa-session:*` sampai dimatikan. Key basi itu akan dibersihkan (tidak menimpa) pada start berikutnya. Kalau WA sempat terputus setelah deploy, cukup scan QR ulang.
