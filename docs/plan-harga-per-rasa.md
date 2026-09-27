# Plan: Harga jual per rasa per store

Status: **✅ diimplementasi (fase A–D)** (2026-09-27). Migration `1789842090778_variant-price-per-store` perlu dijalankan di prod. Fase E belum.
Menggantikan fase C–D di `plan-addons.md` (add-on tetap ditunda). Fase A (snapshot harga di order) sama dengan plan add-on.

## Keputusan
- Harga jual diisi **per rasa**, di form **Varian & resep**, dalam 2 kolom: **Harga Box Besar** dan **Harga Box Kecil**.
- Harga **per store**, seperti resep, dan **ikut tersalin** saat resep disalin ke store lain ("Simpan juga ke" / salin resep).
- **Harga kosong → rasa tidak bisa dijual di store itu**, seperti aturan resep. Lebih rinci:
  - Box Besar kosong → rasa tidak bisa dipilih untuk Box Besar;
  - Box Kecil kosong → rasa tidak bisa dipilih untuk Box Kecil;
  - keduanya kosong → rasa tidak bisa diaktifkan di tab Ketersediaan (terkunci dengan pesan "isi harga dulu").
- **Harga box mix = harga rasa termahal di box itu.** Contoh: Choco (60.000) + Choco Cheese (68.000) → **68.000**. Tanpa pembulatan.
- Box Kecil hanya 1 rasa, jadi harganya harga Box Kecil rasa itu.
- **Edit order → harga dihitung ulang** dengan harga terbaru.
- `menu.price` tidak lagi dipakai untuk harga jual. Kolomnya tetap ada untuk order lama. Di tab Menu box, isiannya diganti keterangan "harga diatur per rasa".

## Kondisi sekarang (yang terdampak)
- Harga hanya ada di `menu.price` (1 harga per jenis box).
- `order_items` **tidak menyimpan harga**. Semua total dihitung ulang dari `menu.price × qty`:
  - Backend:
    - `finance.service.ts`;
    - `orderEvents.service.ts` (WhatsApp);
    - `menu.service.ts` `buildShippingItems` / `boxShippingItem` dan `biteship.service.ts` (nilai barang Biteship).
  - Frontend:
    - `hooks/useMenuPrices.ts`, dipakai di `app/page.tsx` (form order), `app/orders`, `app/cashflow`, `app/finance`, `app/shipping`, `app/bukti-transfer/[id]`;
    - `components/PrintReceipt.tsx`, `utils/printer.ts`.
- Di prod saat ini **0 order**.

## Desain
### Data (1 migration)
```
variant_price     variant_id → variant (CASCADE), store_id → stores (CASCADE),
                  price_full numeric(12,2) NULL, price_half numeric(12,2) NULL (≥ 0)
                  unique (variant_id, store_id)
order_items       + unit_price numeric(12,2)   -- harga 1 box saat order/edit (snapshot)
                  + price_variant_id int NULL  -- rasa yang menentukan harga (termahal)
```
- **Seed** harga awal per store yang sudah menjual rasa itu, berdasarkan nama. Semuanya bisa diubah di UI:

  | Rasa | Box Besar | Box Kecil |
  |---|---|---|
  | Basic (Choco, Vanilla, Greentea, Tiramisu, Strawberry) | 60.000 | 32.500 |
  | Oreo (… Oreo) | 65.000 | 35.000 |
  | Keju (… Cheese, Milk Cheese, Caramel Cheese, Choco Special) | 68.000 | 37.000 |

- Backfill `order_items.unit_price` dengan `menu.price` (order lama, kalau ada).

### Perhitungan (fungsi murni `computeBoxPrice`)
```
harga_rasa(v, store, box) = variant_price[v, store].price_full | price_half   (NULL → tidak boleh dijual)
harga_box   = MAX(harga_rasa untuk semua rasa di box)
total order = Σ unit_price × qty   (+ ongkir seperti sekarang)
```
- Server selalu menghitung ulang harga saat `createOrder`/`updateOrder`. Harga dari client diabaikan.
- Validasi order: rasa tanpa harga untuk jenis box itu di store itu → 400 "Rasa X belum ada harga Box Kecil di store ini".
- Harga di-*snapshot* ke `order_items.unit_price`. Mengubah harga rasa tidak mengubah order lama, kecuali order itu diedit.

### Aturan ketersediaan (diperluas)
Rasa bisa dijual di store S kalau: **ada resep di S** (sudah ada) **dan ada minimal satu harga di S**.
- `assertStoresHaveRecipe` → `assertStoresCanSell` (resep + harga).
- Menghapus kedua harga di S → rasa otomatis tidak dijual lagi di S (sama seperti mengosongkan resep).
- `GET /variants` menambah `price_store_ids` (store yang punya harga) dan `prices: { [store_id]: { full, half } }`.

### Salin ke store lain
- `copyVariantRecipes` (dipakai "Simpan juga ke" dan panel salin resep) **ikut menyalin harga**.
- Harga di store tujuan diganti.

### API
| Method | Path | Isi |
|---|---|---|
| GET | `/variant-price?store_id=` | harga semua rasa di store |
| PUT | `/variant-price` | `{ variant_id, store_id, price_full, price_half }` (null = kosong) |
| GET | `/variants` | + `prices`, `price_store_ids` (cache varian dihapus saat harga berubah) |
| POST | `/orders/quote` | `{ store_id, pesanan }` → harga per item + total (untuk form order) |
| GET | `/orders`, `/orders/:id` | + `unit_price`, `total_amount` |

### UI
- **Varian & resep** (form rasa, per store aktif):
  ```
  Harga jual · Kalibata    Box Besar Rp [68.000]    Box Kecil Rp [37.000]
  HPP                      Box Besar Rp 30.990 · margin 54,4%   ·   Box Kecil Rp 16.305 · margin 55,9%
  ```
  - Harga disimpan bersama resep (tombol Simpan resep), dan "Simpan juga ke" menyalin resep + harga.
  - Daftar rasa menampilkan harga Box Besar, dan badge "Belum ada harga" kalau kosong.
- **Ketersediaan**: store tanpa harga terkunci dengan pesan "Isi harga di {store} dulu" dan tombol ke form rasa.
- **Setup checklist**: langkah "Harga jual" (rasa aktif tanpa harga di store ini).
- **Menu box**: isian harga diganti keterangan "Harga jual diatur per rasa di Varian & resep".
- **Form order (`app/page.tsx`)**:
  - rasa tanpa harga untuk jenis box itu tidak tampil;
  - setiap rasa menampilkan harganya;
  - harga box = rasa termahal yang dipilih, dan langsung berubah saat memilih;
  - total dari harga per box.
- **Semua total** (orders, cashflow, finance, shipping, bukti transfer, struk/printer, WhatsApp, Biteship) memakai `unit_price` dari order. `useMenuPrices` dihapus.

## Fase
1. **Fase A: snapshot harga di order**
   - Migration `unit_price`, `price_variant_id`, dan backfill.
   - `createOrder`/`updateOrder` mengisi `unit_price` (sementara dari `menu.price`).
   - `total_amount` di query order.
   - Semua perhitungan total di backend dan frontend pindah ke `unit_price`.
   - Test: mengubah harga tidak mengubah order lama.
2. **Fase B: harga per rasa per store**
   - Migration `variant_price` + seed.
   - `computeBoxPrice` + unit test (1/2/3 rasa, rasa termahal, harga kosong).
   - API `/variant-price`.
   - Aturan ketersediaan (resep + harga).
   - Salin resep ikut harga.
   - `createOrder`/`updateOrder` memakai harga rasa.
   - `/orders/quote`.
3. **Fase C: UI admin**
   - Input harga + margin di form rasa.
   - Badge di daftar rasa.
   - Ketersediaan terkunci tanpa harga.
   - Setup checklist.
   - Menu box tanpa isian harga.
4. **Fase D: form order & tampilan**
   - Harga per rasa, harga box ikut rasa termahal, dan total.
   - Struk, WhatsApp, Biteship.
   - Hapus `useMenuPrices`.
5. **Fase E (opsional, nanti): HPP after di sistem**
   - Pisang sebagai bahan dasar.
   - Biaya operasional per box per store.
6. Test integration menyeluruh + docs.
