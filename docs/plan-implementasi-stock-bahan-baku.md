# Plan implementasi — Stock bahan baku (resep, HPP, auto-potong)

> **Status eksekusi:** lihat [`fase/README.md`](./fase/README.md). Fase 0 dan A–E di dokumen ini menjadi fase 00 dan 03–06 di sana.

Turunan eksekusi dari design doc [`plan-stock-bahan-baku.md`](./plan-stock-bahan-baku.md). Design doc = *apa & kenapa*; dokumen ini = *urutan task, gap yang ditemukan saat cek codebase, dan keputusan yang masih perlu dikonfirmasi*.

---

## 0. Gap design doc vs codebase (harus diselesaikan dulu)

| # | Temuan | Dampak | Usulan |
|---|---|---|---|
| G1 | Constraint `stock_qty_check` (`migrations/1772650400000_add-check-constraints.js:19`) melarang `stock.qty < 0` | Keputusan "stok boleh minus" **tidak bisa jalan** — `UPDATE stock SET qty = qty - x` akan error, dan karena dibungkus try/catch, potong stok gagal diam-diam | Migration drop constraint `stock_qty_check` (atau ganti jadi hanya berlaku untuk input manual — tidak mungkin di level constraint, jadi drop) |
| G2 | Order dibuat dari **3 halaman**: `app/page.tsx` (publik), `app/pesan/page.tsx` (POST `/api/order`, staff), `app/orders/page.tsx` (edit, `PATCH /order/:id`) — masing-masing punya flavor picker sendiri | Design doc hanya menyebut `app/page.tsx` → order dari `/pesan` & edit admin tidak punya `variant_ids` → stok tidak terpotong | Ekstrak komponen `FlavorPicker` bersama, dipakai ketiga halaman; `updateOrder` juga terima `variant_ids` |
| G2b | Batas rasa FULL tidak konsisten: `app/page.tsx:769` = 3, `app/pesan/page.tsx:585` & `app/orders/page.tsx:1187` = 2 | Validasi backend (G8) tidak punya satu angka acuan | Tentukan satu nilai (lihat K4), simpan sebagai konstanta bersama / kolom `menu.max_flavors` |
| G3 | Design doc tidak mengatur **cancel / un-cancel / edit** order | Order dibatalkan → stok tetap terpotong; edit pesanan → stok tidak disesuaikan | Lihat keputusan K1 di bawah |
| G4 | `adjustStock` (`stock.service.ts`) = read → hitung → write via supabase-js, tidak atomik | Auto-potong (dari order) + stok masuk manual bersamaan → lost update | Tulis ulang pakai `pg` transaction + `UPDATE ... SET qty = qty + $1 RETURNING qty` |
| G5 | `stock.unit` bebas (`'kg'`, `'pcs'`, …), resep pakai gram | Resep yang menunjuk stock ber-unit kg memotong 1000× terlalu banyak | Dropdown resep di `/config` hanya tampilkan stock `unit IN ('gram','g')`; backend tolak di `PUT /variant-recipe` kalau unit bukan gram |
| G6 | Deteksi Mix 3 di FE pakai `variant_name.startsWith('mix 3')` (`app/page.tsx:765`) | Setelah ada `variant_components`, sumber kebenaran ganda | FE tentukan "preset mix" dari ada/tidaknya komponen (endpoint `/variants` sertakan `component_ids`); prefix nama jadi fallback saja |
| G7 | Order lama tidak punya `variant_ids` | Tidak bisa dipotong/di-reverse | Auto-potong hanya untuk order baru (yang punya `order_item_variants`); reversal cancel hanya jalan kalau ada history potongnya (lihat K1) |
| G8 | `variant_ids` dari client tidak divalidasi | Client bisa kirim id sembarang / terlalu banyak rasa | Backend validasi: id ada & aktif, jumlah ≤ batas per box_type (HALF 1, FULL sesuai K4), preset mix tidak boleh dicampur rasa lain |
| G9 | `stock_history` tidak punya referensi ke order | Idempotensi & reversal harus parsing `notes` | Tambah kolom `order_id integer NULL REFERENCES orders ON DELETE SET NULL` + index |

### Keputusan (sudah dikonfirmasi user)

- **K1 — Cancel/edit order → stok dikembalikan: YA.** Status → CANCELLED: insert `stock_history` type `IN` (reversal) sebesar net potongan order itu; un-cancel → potong ulang; edit `pesanan` → reverse lama + potong baru. Semua berdasarkan `stock_history.order_id` supaya idempotent.
- **K2 — Order UNPAID yang tidak pernah dibayar tetap terpotong** sampai admin cancel manual: YA. Auto-cancel di luar scope.
- **K3 — HAMPERS dihapus seluruhnya** sebagai bagian dari plan ini (lihat Fase 0). Setelahnya `box_type` hanya FULL/HALF, jadi tidak ada resep hampers yang perlu diputuskan.

### Masih perlu dikonfirmasi
- **K4 — Maks rasa untuk FULL box: 2 atau 3?** (G2b). Preset "Mix 3" tetap dihitung sebagai 1 pilihan.

---

## Fase 0 — Hapus HAMPERS

Dikerjakan **pertama**, karena menyederhanakan semua fase berikutnya (kuota, resep, validasi). Disarankan juga sebelum Fase 2 [`plan-perbaikan-issue.md`](./plan-perbaikan-issue.md) supaya fix kuota tidak perlu menangani dua jenis kuota.

### 0.1 Cek data dulu (dijalankan user di Supabase SQL editor)
```sql
SELECT count(*) FROM order_items WHERE box_type = 'HAMPERS';
SELECT o.status, count(*) FROM orders o JOIN order_items oi ON oi.order_id = o.id
 WHERE oi.box_type = 'HAMPERS' GROUP BY o.status;
SELECT * FROM menu WHERE name = 'HAMPERS';
SELECT count(*) FROM daily_quota WHERE hampers_qty > 0;
SELECT count(*) FROM hourly_quota WHERE hampers_qty > 0;
```
- Kalau ada order hampers **aktif** (UNPAID/PAID/CONFIRMED) → selesaikan/cancel dulu sebelum deploy.
- Order hampers **historis** (DONE/CANCELLED): baris `order_items` dibiarkan agar laporan keuangan lama tetap benar → itu sebabnya constraint DB tetap mengizinkan nilai lama (lihat 0.2).

### 0.2 Migration
| # | Migration | Isi |
|---|---|---|
| 0a | `1789842074778_remove-hampers.js` | `DROP COLUMN hampers_qty` dari `daily_quota` & `hourly_quota`; `UPDATE menu SET is_active = false WHERE name = 'HAMPERS'` (soft delete — hard delete hanya kalau 0.1 menunjukkan tidak ada order historis). Constraint `order_items_box_type_check` **tidak** diubah (masih mengizinkan HAMPERS untuk data lama); penolakan order hampers baru dilakukan di backend. `down`: add kolom kembali default 0, `is_active = true` |

(Timestamp migration Fase A digeser +1 — lihat tabel Fase A.)

### 0.3 Backend
| File | Perubahan |
|---|---|
| `services/order.service.ts` | `OrderItem.box_type = 'FULL' \| 'HALF'`; validasi tolak HAMPERS (400 "Hampers sudah tidak tersedia"); hapus `requestedHampersQty`, `reservedHampers`, `reservedHourlyHampers` & semua key `quota:hampers:*` / `hourly:hampers:*` |
| `services/dailyQuota.service.ts` | Hapus `hampers_qty`, `remaining_hampers_qty`, `used_hampers_qty`, key `quota:hampers:*`; parameter `createDailyQuota`/`updateDailyQuota` tanpa hampers |
| `services/hourlyQuota.service.ts` | Sama untuk hourly |
| `routes/dailyQuota.route.ts`, `routes/hourlyQuota.route.ts` | Hapus `hampers_qty` dari body |
| `routes/order.route.ts` | Label box (baris 62, 260) jadi 2 cabang; blok restore kuota legacy 163-191 dihapus (sekalian Fase 2c plan perbaikan) |
| Redis | Setelah deploy: `SCAN` + `DEL` pola `quota:hampers:*` dan `hourly:hampers:*` |

### 0.4 Frontend
| File | Perubahan |
|---|---|
| `types/menu.ts` | `name: 'FULL' \| 'HALF'` |
| `app/page.tsx` | Tipe (34), label (214, 419, 881), `maxFlavors` (742, 769), cek `remaining_hampers_qty` (306) |
| `app/pesan/page.tsx` | Tipe (31), label (183, 386, 850), tombol pilihan box `['FULL','HALF','HAMPERS']` (527) + ikon `LuGift` (531), `maxFlavors` (558, 585), kuota (275, 282-289) |
| `app/orders/page.tsx` | Tipe (40, 315, 323, 864), label (745), tombol box (1108, 1115), `maxFlavors` (1169, 1187), aturan khusus `isKraftDisabled` hampers (1197), kuota (276, 350-357) |
| `app/config/page.tsx` | State `newQuotaHampers`/`newHourlyHampers`, input "Hampers Qty" (423-427, 511-512, 552-553), semua argumen `hampers_qty` di update/toggle (180-270, 309-316, 546-557) |
| `app/finance/page.tsx` | Tipe (24) & `PRICE.HAMPERS` (41-44). Karena order hampers historis tetap ada, tampilkan fallback "Lainnya" untuk box_type yang tidak dikenal — jangan crash |
| `utils/printer.ts` | Tipe (129) & seksi `[ HAMPERS ]` (208-241) — tetap aman untuk struk order lama dengan cara yang sama |

Tipe `box_type` di 6 file di atas diganti satu tipe bersama `BoxType` di `types/menu.ts`.

### 0.5 Verifikasi
- `grep -rni hampers rpn-backend/src rpn-frontend/app rpn-frontend/utils rpn-frontend/types` → tidak ada hasil (kecuali fallback data lama di finance/printer yang ditandai komentar).
- `npm run build` di kedua repo.
- POST `/api/order` dengan `box_type: 'HAMPERS'` → 400.
- `/config` kuota harian & jam tampil & bisa disimpan tanpa kolom hampers; halaman `/finance` untuk periode yang dulu ada hampers tetap terbuka.

---

## Fase A — Fondasi data (Fitur 1, backend)

Migration mulai timestamp `1789842075778` (terakhir saat ini: `1789842073778_add-open-time-to-stores.js`; `…074778` dipakai Fase 0).

| # | Migration | Isi |
|---|---|---|
| A1 | `1789842075778_add-store-id-to-stock.js` | `store_id` + backfill `1` + `NOT NULL` + index (pola `add-store-id-to-daily-quota.js`) |
| A2 | `1789842076778_drop-stock-qty-check.js` | Drop `stock_qty_check` (G1); `down` re-add dengan `NOT VALID` |
| A3 | `1789842077778_add-box-multiplier-to-menu.js` | `box_multiplier numeric(4,2) NOT NULL DEFAULT 1.00`; HALF = 0.50 (FULL = 1.00; tidak ada hampers lagi). Sekalian `max_flavors smallint` (HALF 1, FULL sesuai K4) untuk G2b |
| A4 | `1789842078778_create-variant-recipe.js` | Sesuai design doc + `CHECK (qty_gram > 0)` + index `(variant_id, store_id)` |
| A5 | `1789842079778_create-variant-components.js` | Sesuai design doc + `CHECK (variant_id <> component_variant_id)`; seed komponen untuk preset Mix 3 (id 18/19/20 — **cek ulang id & komponennya di DB sebelum menulis seed**) |
| A6 | `1789842080778_create-order-item-variants.js` | Sesuai design doc |
| A7 | `1789842081778_add-order-id-to-stock-history.js` | G9 |

Backend:
1. `stock.service.ts` → pindah ke `pg`; `getStocks(store_id)`, `adjustStock` atomik (G4), tambah `createStock` bila belum ada. `stock.route.ts`: `GET /stocks?store_id=`.
2. `menu.service.ts` → sertakan & bisa update `box_multiplier`.
3. `variantRecipe.service.ts` + `variantRecipe.route.ts` (daftarkan di `src/routes/index.ts`, **bukan** `src/index.ts` seperti tertulis di design doc):
   - `GET /variant-recipe?variant_id=&store_id=`, `PUT /variant-recipe` (upsert list), `DELETE /variant-recipe/:id`
   - `GET /variant-components?variant_id=`, `PUT /variant-components`
   - `resolveBoxCost(variantIds, boxType, storeId, client?)` — terima `PoolClient` opsional supaya bisa dipanggil di dalam transaksi.
4. `variant.service.ts` → `getVariants` sertakan `component_ids` (G6).

**Unit test `resolveBoxCost`** (murni, mock query): 1 rasa FULL; 2 rasa FULL (masing-masing 1/2); HALF (×0.5); preset Mix 3 diekspansi ke 3 komponen; variant tanpa resep → kontribusi 0, bukan error.

## Fase B — Fondasi FE (Fitur 1, frontend)

1. `types/menu.ts`: `Menu.box_multiplier?`, `Variant.component_ids?`, `OrderItem.variant_ids: number[]`.
2. Komponen baru `components/FlavorPicker.tsx` — ekstrak dari `app/page.tsx:~765-830`; output `{ name, variant_ids }`; batas rasa dari `menu.max_flavors`. Pakai di `app/page.tsx`, `app/pesan/page.tsx`, **dan** `app/orders/page.tsx` (G2).
3. `submitOrder` (`app/page.tsx:340`), submit `/pesan` (`app/pesan/page.tsx:332`), & edit order admin (`app/orders/page.tsx:~379`) kirim `variant_ids`.
4. Backend `createOrder`/`updateOrder`: validasi `variant_ids` (G8), insert `order_item_variants` di transaksi yang sama.
5. `app/stock/page.tsx`: store-tabs + `store_id` di semua request.
6. `app/config/page.tsx`: sub-panel "Resep Bahan Baku" (dropdown stock ber-unit gram saja — G5) & "Komponen Rasa"; input `box_multiplier` di kartu menu.

✅ **Checkpoint:** deploy A+B. Order baru sudah menyimpan `order_item_variants`, belum ada potong stok → aman. Admin mulai isi resep.

## Fase C — HPP (Fitur 2)

Bisa paralel dengan Fase D setelah A+B.

1. Migration `1789842082778_add-price-to-stock.js`: `stock.price_per_unit numeric(12,4)`, `stock_history.total_price numeric(12,2)`.
2. `adjustStock`: param opsional `total_price` (hanya untuk `type='IN'`, `qty_change > 0`) → set `price_per_unit = total_price / qty_change` di transaksi yang sama.
3. `GET /variant-hpp?variant_ids=1,2&box_type=FULL&store_id=1` → `{ hpp, breakdown: [{stock_id, item_name, gram, price_per_unit, subtotal}], missing_price: [stock_id...] }`. `missing_price` supaya UI bisa memberi tahu "harga Tepung belum diisi" alih-alih diam-diam menghitung 0.
4. FE `/stock`: field "Total Harga Beli" + preview Rp/gram. FE `/config`: HPP FULL & HALF live, debounce 300ms.

## Fase D — Auto-potong stok (Fitur 3)

Prasyarat: Fase 1–2 [`plan-perbaikan-issue.md`](./plan-perbaikan-issue.md) sudah selesai (sama-sama menyentuh `createOrder`/`updateOrder`). K1 & K2 sudah dikonfirmasi (reversal saat cancel/edit; UNPAID tetap terpotong).

1. `src/services/stockDeduction.service.ts`:
   - `applyOrderStock(orderId)`: kalau sudah ada `stock_history` OUT untuk `order_id` ini → skip (idempotent). Dalam satu transaksi `pg`: per item → `resolveBoxCost` × `item.qty` → gabungkan per `stock_id` → `UPDATE stock SET qty = qty - $1 ... RETURNING qty` → insert `stock_history` (`type='OUT'`, `order_id`, `notes`).
   - `reverseOrderStock(orderId)`: jumlahkan net potongan `stock_history` untuk `order_id` → kembalikan dengan `type='IN'`, `notes='Reversal Order #id'`.
2. Hook:
   - `createOrder`: setelah commit → `applyOrderStock(order.id).catch(log)`.
   - `updateOrderStatus`: → CANCELLED: `reverseOrderStock`; CANCELLED → lainnya: `applyOrderStock` (setelah reversal, cek idempotensi pakai net = 0).
   - `updateOrder` dengan `pesanan` baru: `reverseOrderStock` lalu `applyOrderStock`.
3. Logging: kegagalan potong stok di-log dengan prefix `[stock]` + order id supaya mudah dicari di log Render. Opsional: endpoint admin `POST /order/:id/reapply-stock` untuk retry manual.

## Fase E — Verifikasi

- `npm run build` (tsc) di backend, `npm run build` di frontend.
- Test otomatis `resolveBoxCost` + `applyOrderStock`/`reverseOrderStock` terhadap Postgres lokal (**bukan** Supabase produksi).
- Manual oleh user lewat UI (sesuai design doc — DB lokal konek ke Supabase data real):
  1. Resep: Dark Choco = 50 g Tepung (store 1); stok masuk Tepung 5000 g, total harga Rp 700.000 → Rp 140/g.
  2. `/config`: HPP FULL Rp 7.000, HALF Rp 3.500.
  3. Order 2× FULL Dark Choco → Tepung −100 g, `stock_history` OUT dengan `order_id`.
  4. Order 1× FULL Mix Dark Choco + Vanilla → Tepung −25 g (kalau Vanilla tanpa resep Tepung).
  5. Cancel order langkah 3 → Tepung +100 g (reversal). Un-cancel → −100 g lagi. Cancel dua kali → tidak double.
  6. Stok dibuat hampir habis → order tetap sukses, `stock.qty` negatif (membuktikan G1 beres).

## Ringkasan urutan

```
0 (hapus hampers) ─► Plan perbaikan Fase 1–2 ─┐
                                              ├─► A (migration+BE) ─► B (FE, checkpoint deploy) ─┬─► C (HPP)
Konfirmasi K4 ────────────────────────────────┘                                                  └─► D (auto-potong)
                                                                                                          └─► E (verifikasi)
```

Estimasi kasar: 0 1 hari · A 1.5 hari · B 2 hari · C 1 hari · D 1.5 hari · E 0.5–1 hari.
