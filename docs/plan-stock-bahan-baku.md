# Stock bahan baku: resep per box, HPP, dan auto-potong stok

## Context
`stock` (bahan baku) sudah ada di RPN tapi murni generic inventory manual (item_name, qty, unit, harga) — tidak ada hubungan ke `menu`/`variant`, dan `createOrder` sama sekali tidak menyentuh stock. User mau bangun 3 hal yang saling bertumpuk, supaya lebih jelas dipecah begini:

- **Fitur 1 — Tabel "Pemakaian Stock per Box"** (fondasi, dikerjakan duluan): definisi gram tiap bahan baku yang dipakai untuk 1 box (satuan FULL box) per variant/topping. Semua fitur di bawah pakai data ini sebagai basis.
- **Fitur 2 — HPP (harga modal per rasa)**: dari harga beli stock (mis. "Cokelat 5kg = Rp 700.000" → otomatis Rp 140/gram) dikali gram pemakaian di Fitur 1 → HPP per variant, termasuk kombinasi mix 2/3 rasa.
- **Fitur 3 — Auto potong stock saat order dibuat**: begitu order tercipta (status awal **UNPAID**, tidak nunggu bayar/DONE), stock otomatis berkurang sesuai Fitur 1, berdasarkan rasa yang dipesan.

Riset codebase menemukan 2 kerumitan yang menentukan desain Fitur 1:
1. **`order_items` tidak punya `variant_id`** — cuma kolom `name` (teks bebas). Untuk box FULL/HAMPERS, customer bisa pilih sampai 3 rasa dicampur dalam 1 box (`app/page.tsx` menyimpannya sebagai string "Mix ChocoOreo Dan Vanilla"), HALF cuma 1 rasa. Ada juga variant preset "Mix 3 (...)" (id 18/19/20) yang merupakan baris variant tersendiri, bukan hasil campur manual — user putuskan resepnya **auto-dihitung dari 3 variant komponennya**, bukan diinput manual.
2. **`stock` sekarang harus per-store** (keputusan user, karena sudah multi-store dan tiap toko punya stok fisik sendiri) — ini juga menutup gap yang sebelumnya dilaporkan ("/stock belum ada StoreFilter").

Keputusan produk yang sudah dikonfirmasi:
- Box campur N rasa → tiap rasa dianggap pakai **1/N** dari resep normalnya (resep didefinisikan dalam satuan 1 box FULL/"box standar", HALF = dibagi 2 via `menu.box_multiplier`).
- Stok tidak cukup → **order tetap jalan, stok boleh minus** (tidak block, beda dari kuota harian/jam).
- Harga modal per gram = **harga pembelian terakhir** (bukan rata-rata tertimbang) — sederhana, sesuai cara user kasih contoh.

---

## Fitur 1 — Tabel "Pemakaian Stock per Box" (fondasi)

### Migration baru (`rpn-backend/migrations/`, mulai timestamp `1789842074778`)
1. `..._add-store-id-to-stock.js` — tambah `store_id integer REFERENCES stores(id)`, backfill existing ke `store_id = 1`, set `NOT NULL`. Ikut pola persis `add-store-id-to-daily-quota.js`.
2. `..._add-box-multiplier-to-menu.js` — tambah `box_multiplier numeric(4,2) NOT NULL DEFAULT 1.00` ke `menu`. `UPDATE menu SET box_multiplier = 0.50 WHERE name = 'HALF'` (FULL & HAMPERS tetap 1.00, admin bisa ubah nanti).
3. `..._create-variant-recipe.js` — tabel inti "pemakaian stock per box":
   ```
   variant_recipe: id, variant_id (FK→variant, CASCADE), store_id (FK→stores),
                   stock_id (FK→stock), qty_gram numeric(10,2) NOT NULL,
                   created_at, updated_at
   UNIQUE (variant_id, store_id, stock_id)
   ```
   Per-store karena `stock_id` merujuk baris stock yang sudah store-scoped — admin set resep terpisah untuk tiap store (dropdown stock item di-filter ke store yang sedang aktif, sama seperti pola store-tabs yang sudah ada di `/config`).
4. `..._create-variant-components.js` — tabel komposisi untuk preset Mix (TIDAK per-store, komposisi rasa sama di semua tempat):
   ```
   variant_components: id, variant_id (FK→variant, CASCADE, "si preset mix"),
                        component_variant_id (FK→variant, CASCADE, "salah satu rasa penyusun"),
                        created_at
   UNIQUE (variant_id, component_variant_id)
   ```
5. `..._create-order-item-variants.js` — variant_id asli yang dipilih customer per order_item (many-to-many karena box campur):
   ```
   order_item_variants: id, order_item_id (FK→order_items, CASCADE), variant_id (FK→variant)
   UNIQUE (order_item_id, variant_id)
   ```

### Backend
- **`variantRecipe.service.ts` + `.route.ts`** (baru): `GET/PUT/DELETE /variant-recipe` (per variant+store), `GET/PUT /variant-components`.
- **Fungsi bersama `resolveBoxCost(variantIds, boxType, storeId)`** (dipakai ulang oleh Fitur 2 & 3 — ini kuncinya supaya logic mix/split cuma ditulis 1x):
  1. Ekspansi: kalau sebuah `variant_id` punya baris di `variant_components`, ganti dengan daftar `component_variant_id`-nya. Kalau tidak, pakai apa adanya.
  2. `weight = 1 / jumlah_leaf_variant_ids`
  3. `box_multiplier` dari `menu.box_multiplier` sesuai `box_type`.
  4. Untuk tiap leaf variant_id, ambil baris `variant_recipe WHERE variant_id=$1 AND store_id=$2` → list `{ stock_id, qty_gram_terpakai: qty_gram * box_multiplier * weight }`.
  Fitur 2 pakai hasil ini dikali `stock.price_per_unit`. Fitur 3 pakai hasil ini untuk `UPDATE stock`.

### Frontend
- **`app/page.tsx`**: `OrderItem` tambah `variant_ids: number[]` di samping `name` (name tetap ada untuk display). Titik toggle rasa (baris ~782-819) diubah supaya juga simpan `id` variant yang dipilih, tidak cuma nama. `submitOrder` sertakan `variant_ids` per item.
- **`app/config/page.tsx`**: di kartu tiap variant, sub-panel baru "Resep Bahan Baku" — dropdown stock item (difilter ke `activeStoreId`) + input gram, list resep dengan tombol hapus. Sub-panel terpisah "Komponen Rasa (untuk preset Mix)" — multi-select variant lain penyusunnya.
- **`app/stock/page.tsx`**: tambah store-tabs (pola sama `/config`), tiap fetch/create/update stock disertai `store_id`.

---

## Fitur 2 — HPP per variant

Dikerjakan setelah Fitur 1 ada (butuh `variant_recipe` + `resolveBoxCost`).

### Migration tambahan
- `..._add-price-per-unit-to-stock.js` — tambah `price_per_unit numeric(12,4)` ke `stock` (nullable, cuma relevan untuk stock yang dipakai di resep — asumsi `unit='gram'`). Tambah `total_price numeric(12,2)` ke `stock_history` (nullable, dipakai khusus baris `type='IN'`).

### Backend
- **`stock.service.ts`**: fungsi "Stok Masuk" (dipanggil dari `/stock`) terima parameter baru opsional `total_price`. Kalau diisi: `price_per_unit = total_price / qty_change`, simpan ke `stock.price_per_unit` (menimpa — "harga modal terkini") + `stock_history.total_price`.
- **`GET /variant-hpp?variant_ids=1,2&box_type=FULL&store_id=1`** (baru, di `variantRecipe.route.ts`): panggil `resolveBoxCost(...)`, kalikan tiap `qty_gram_terpakai` dengan `stock.price_per_unit`, jumlahkan → 1 angka HPP rupiah. Kerja untuk 1 variant tunggal maupun preview mix 2/3 rasa (kirim beberapa `variant_ids`).

### Frontend
- **`app/stock/page.tsx`**: modal "Stok Masuk (IN)" tambah field opsional "Total Harga Beli" — begitu diisi bareng qty, tampilkan live "≈ Rp .../gram", kirim sebagai `total_price`. List stock tampilkan `price_per_unit` terkini kalau ada.
- **`app/config/page.tsx`**: di sub-panel "Resep Bahan Baku" tiap variant, tampilkan angka **HPP per FULL box / per HALF box** live (panggil `/variant-hpp`) tiap resep berubah.

---

## Fitur 3 — Auto potong stock saat order dibuat (termasuk UNPAID)

Dikerjakan setelah Fitur 1 ada (butuh `variant_recipe` + `resolveBoxCost` + `order_item_variants`).

### Backend (`order.service.ts`, `createOrder`)
- Di dalam transaksi insert order_items yang sudah ada: tiap item terima `variant_ids: number[]` dari payload (lihat Fitur 1 FE), insert ke `order_item_variants` (butuh `order_item.id` baru, tetap di transaksi yang sama — cuma data relasi).
- **Setelah** transaksi order berhasil commit dengan status awal **UNPAID** (bukan nunggu PAID/DONE, dan bukan di dalam transaksi yang sama — supaya gagalnya perhitungan stok TIDAK PERNAH menggagalkan order, sesuai keputusan "stok minus, order tetap jalan"): panggil `applyStockDeduction(order, store_id)`, dibungkus try/catch (log error, tidak throw). Per order_item: panggil `resolveBoxCost(item.variant_ids, item.box_type, store_id)`, lalu untuk tiap `{stock_id, qty_gram_terpakai}`: `deduct = qty_gram_terpakai * item.qty`, `UPDATE stock SET qty = qty - deduct WHERE id = stock_id RETURNING qty`, insert `stock_history` (`type='OUT'`, `qty_change=-deduct`, `final_qty`, `notes='Order #<id> - <variant_name> x<qty>'`).

**Catatan scope**: `variant_recipe.qty_gram` mengasumsikan stock item yang dipakai punya `unit='gram'`. Tidak ada validasi/konversi unit otomatis — tanggung jawab admin memilih stock item yang benar saat setup resep.

---

## Files yang disentuh
Backend: 6 migration baru, `variantRecipe.service.ts` + `.route.ts` (baru — termasuk `resolveBoxCost` dan endpoint `/variant-hpp`), `stock.service.ts`/`stock.route.ts` (tambah `store_id` + `price_per_unit`/`total_price`), `menu.service.ts` (tambah `box_multiplier`), `order.service.ts` (logic Fitur 3), `index.ts` (register route baru).

Frontend: `app/page.tsx`, `app/config/page.tsx`, `app/stock/page.tsx`, `types/menu.ts` (tambah `box_multiplier?` ke `Menu`).

## Urutan pengerjaan yang disarankan
1. Fitur 1 dulu (migration + resep + FE kirim variant_ids) — tanpa ini, Fitur 2 & 3 tidak punya data untuk dipakai.
2. Fitur 2 & 3 bisa paralel setelah Fitur 1 selesai (keduanya independen satu sama lain, sama-sama cuma butuh `resolveBoxCost`).

## Verifikasi
- Migration: `npm run migrate up`, cek kolom via `GET /api/stock` (setelah store_id + price_per_unit ditambahkan).
- `tsc --noEmit` di kedua repo.
- Manual: set 1 resep test (Dark Choco butuh 50g "Tepung" di store 1, harga modal Tepung Rp 140/gram lewat restock) → cek HPP di `/config` masuk akal (50 × 140 = Rp 7.000 FULL, Rp 3.500 HALF). Lalu **user yang trigger order test manual** lewat UI (bukan saya via curl/API, karena DB ini konek ke Supabase yang sama dengan data real) — cek `stock.qty` berkurang begitu order UNPAID tercipta, sesuai `box_multiplier` & jumlah rasa campuran, dan `stock_history` tercatat dengan `notes` yang mengarah ke order id-nya.
