# Fase 03: Stock A, fondasi data & backend

**Status:** ✅ kode selesai · ⏳ migrate + deploy oleh user
**Referensi:** [design doc](../plan-stock-bahan-baku.md) Fitur 1 · [plan implementasi](../plan-implementasi-stock-bahan-baku.md) Fase A, gap G1/G4/G5/G8/G9

## Migration
Diuji di Postgres lokal (`rpn_migration_test`, dengan stub schema `auth`): semua migration dari nol ✅, `down 8` ✅, `up` lagi ✅.
- [x] A1 `1789842075778_add-store-id-to-stock.js`: `store_id` (FK ke stores, CASCADE), backfill 1, NOT NULL, index.
- [x] A2 `1789842076778_drop-stock-qty-check.js`: `down` menambahkan kembali constraint dengan `NOT VALID`.
- [x] A3 `1789842077778_add-box-multiplier-to-menu.js`: `box_multiplier numeric(4,2)` (> 0) dan `max_flavors smallint` (1–10). HALF = 0.50 / 1; FULL = 1.00 / **3** (K4 belum diputuskan; bisa diubah lewat `PUT /menu/:id`).
- [x] A4 `1789842078778_create-variant-recipe.js`: unique `(variant_id, store_id, stock_id)`, `CHECK qty_gram > 0`, index `(store_id, variant_id)`.
- [x] A5 `1789842079778_create-variant-components.js`: unique dan `CHECK variant_id <> component_variant_id`. **Tanpa seed.**
- [x] A6 `1789842080778_create-order-item-variants.js`
- [x] A7 `1789842081778_add-order-id-to-stock-history.js`: FK `ON DELETE SET NULL` dan index.

## Backend
- [x] `config/db.ts`:
  - Parser `NUMERIC` → number, supaya bentuk response `pg` sama dengan supabase-js (DATE → string sudah ada sejak Fase 02).
  - `PG_SSL=false` untuk Postgres lokal (dipakai test).
- [x] `stock.service.ts` sepenuhnya memakai `pg`:
  - `getStocks(store_id?)`.
  - `createStock` (baru), mencatat history "Stok awal" kalau qty > 0.
  - `adjustStock` dalam satu transaksi dengan `SELECT … FOR UPDATE` (G4), dan sekarang juga mengisi `updated_at`.
  - Input tidak valid → `ValidationError`.
- [x] `stock.route.ts`: `GET /stocks?store_id=`, `POST /stocks` (baru), dan 400 untuk `ValidationError`.
- [x] `menu.service.ts` dan `menu.route.ts`: `PUT /menu/:id` menerima `box_multiplier` dan `max_flavors` (divalidasi). Cache key dinaikkan ke `menu_list:v2` (konstanta `MENU_CACHE_KEY`).
- [x] `variant.service.ts`: `getVariants()` memakai `pg` dan mengembalikan `component_ids` per variant. Cache key `variant_list:v2` (`VARIANT_CACHE_KEY`).
- [x] `variantRecipe.service.ts` dan `variantRecipe.route.ts` (didaftarkan di `routes/index.ts`):
  - `GET /variant-recipe?store_id=[&variant_id=]` mengembalikan baris resep beserta `item_name` dan `unit`.
  - `PUT /variant-recipe { variant_id, store_id, items }` mengganti seluruh resep. Stock harus milik store yang sama dan bersatuan gram (`gram`/`g`/`gr`; G5). Gram > 0, tanpa bahan dobel.
  - `DELETE /variant-recipe/:id`
  - `GET /variant-components[?variant_id=]`
  - `PUT /variant-components { variant_id, component_ids }`: hanya satu level (komponen bukan paket lain, dan paket bukan komponen paket lain). List kosong berarti kembali jadi rasa biasa. Cache variant ikut di-invalidasi.
- [x] `computeBoxCost(...)` (fungsi murni) dan `resolveBoxCost(variantIds, boxType, storeId, db?)`: menerima `PoolClient` opsional supaya bisa dipanggil di dalam transaksi Fase 06. Hasilnya dibulatkan ke 4 desimal.
- [x] `checkVariantSelection(...)` (fungsi murni, G8) dan `loadVariantCatalog()`. Aturannya: minimal 1 rasa, id valid dan aktif, tanpa duplikat, paket mix tidak dicampur, dan jumlah ≤ `menu.max_flavors`. **Belum dipanggil dari `createOrder`**; dipasang di Fase 04.

## Verifikasi
- [x] Unit test `src/services/__tests__/variantRecipe.test.ts` (16 test): 1 rasa, HALF, mix 2 rasa, ekspansi Mix 3, rasa tanpa resep, validasi pilihan rasa, dan `isGramUnit`.
- [x] Integration test `src/services/__tests__/stock.integration.test.ts` (6 test, Postgres lokal lewat `npm run test:db`; otomatis di-skip kalau `TEST_DATABASE_URL` tidak menunjuk localhost):
  - create/adjust dengan history konsisten;
  - stok boleh minus;
  - **10 penyesuaian paralel tidak saling menimpa**;
  - validasi satuan dan store pada resep;
  - `resolveBoxCost` end-to-end (FULL, HALF, mix, per store);
  - aturan komponen, beserta `getVariants().component_ids` dan catalog.
- [x] Total: `npm run test:db` **60 test lulus**; `npm test` (tanpa DB) 54 lulus dan 6 di-skip. `tsc --noEmit` bersih.

## Deploy (user)
- [ ] **Migrate dulu, baru deploy backend.** `getVariants()` membaca tabel `variant_components`, jadi backend Fase 03 akan error kalau tabel itu belum ada. Perilaku order belum berubah.
- [ ] Setelah deploy, isi `store_id` stok yang benar kalau ada stok milik store 2 (backfill memasukkan semuanya ke store 1): `UPDATE stock SET store_id = 2 WHERE id IN (...)`.

## Catatan pengerjaan
- Karena cache key berganti ke `menu_list:v2` / `variant_list:v2`, key lama `menu_list` / `variant_list` tidak dipakai lagi dan boleh dihapus manual (tidak wajib).
- Ada dua client Upstash (`src/config/redis.ts` dan `src/utils/redis.ts`). Belum disatukan; dicatat untuk Fase 10.
