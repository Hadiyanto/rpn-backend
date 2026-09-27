# Plan: Rasa dasar + Add-on (harga box dinamis)

Status: **draft, menunggu keputusan** (2026-09-27)

## Tujuan
Sekarang setiap kombinasi punya varian sendiri (Choco, Choco Cheese, Choco Oreo, Vanilla Cheese, …), dan harga box statis (Box Besar/Box Kecil dari tabel `menu`).
Modelnya diganti menjadi:

| Lapisan | Contoh | Harga | Stok |
|---|---|---|---|
| **Bahan dasar box** (sudah ada) | T.Panir, T.Sasa | termasuk harga box | × porsi box, sekali per box |
| **Rasa dasar** | Cokelat, Vanila, Tiramisu, Greentea, Keju | termasuk harga box | resep rasa, dibagi 1/N kalau mix |
| **Add-on** (baru) | Keju, Caramel, Milk (SKM) | **menambah harga box** | resep add-on × porsi box |

**Harga 1 box = harga box (menu) + Σ harga add-on yang dipilih.**

Contoh: Box Besar Rp 65.000, dengan rasa Cokelat + Vanila dan add-on Keju (+Rp 5.000) dan Caramel (+Rp 4.000), harganya Rp 74.000.

## Temuan penting di kode sekarang
`order_items` **tidak menyimpan harga**. Semua omzet dihitung ulang dari harga menu saat ini × qty:
- `finance.service.ts`
- `orderEvents.service.ts` (notifikasi)
- Frontend: `/cashflow`, `/finance`, `/orders`, `/shipping`, halaman order (`app/page.tsx`), `bukti-transfer`, `PrintReceipt`

Dengan add-on, harga per item tidak lagi bisa ditebak dari `box_type`. Selain itu, kalau harga menu diubah, omzet order lama ikut berubah. Jadi **Fase A wajib duluan**: simpan harga di setiap item order.

## Desain data
```
addon                 id, name (unik), image_url, is_active, store_ids int[], sort_order
addon_price           addon_id, box_type ('FULL'|'HALF'), price       -- harga beda per jenis box
addon_recipe          addon_id, store_id, stock_id, qty_gram          -- gram per 1 Box Besar
order_items           + unit_price numeric   (harga box + add-on, snapshot saat order)
                      + base_price numeric   (harga box saja, snapshot)
order_item_addons     order_item_id, addon_id, price (snapshot), name (snapshot)
```
- Harga dan nama di-*snapshot* saat order dibuat/diubah. Mengubah harga nanti tidak mengubah order lama.
- `addon.store_ids` + `addon_recipe` mengikuti aturan yang sama dengan rasa: add-on hanya bisa dijual di store yang punya resepnya (tab Ketersediaan).

## Perhitungan
- **Harga item** (server yang menghitung, harga dari client diabaikan): `unit_price = menu.price(box_type) + Σ addon_price(addon, box_type)`. Total order = Σ `unit_price × qty`.
- **Stok & HPP per box** (`computeBoxCost`):
  `bahan dasar × porsi` + `Σ resep rasa × porsi × 1/N` + `Σ resep add-on × porsi`.
  Add-on tidak dibagi per rasa, jadi berlaku untuk seluruh box.
- **Validasi**: add-on aktif dan tersedia di store, tidak dobel, dan jumlahnya ≤ `menu.max_addons` (opsional, default tanpa batas).
- **Kuota** tidak berubah (dihitung per box).

## Fase
### Fase A: Snapshot harga di order (fondasi, tanpa perubahan tampilan)
1. Migration: `order_items.base_price`, `order_items.unit_price`. Backfill order lama dengan harga menu saat ini.
2. `createOrder`/`updateOrder` mengisi harga dari tabel menu.
3. Semua perhitungan omzet memakai `unit_price × qty`: backend `finance`, `orderEvents`, dan frontend (cashflow, finance, orders, shipping, bukti transfer, struk). `useMenuPrices` hanya dipakai untuk form order.
4. Test: mengubah harga menu tidak mengubah total order lama.

### Fase B: Master add-on
1. Migration: `addon`, `addon_price`, `addon_recipe`.
2. API: CRUD `/addons`, `PUT /addon-recipe`, dan salin resep add-on ke store lain (reuse logika salin resep rasa).
3. `/config`: tab baru **Add-on** berisi nama, foto, harga Box Besar/Box Kecil, aktif, resep per store dengan HPP, dan "Simpan juga ke". Tab **Ketersediaan** ikut menampilkan add-on.
4. Setup checklist: add-on aktif tanpa harga atau tanpa resep → peringatan.

### Fase C: Order dengan add-on
1. `order_item_addons` dan payload order `pesanan[].addon_ids`.
2. Server menghitung `unit_price`, memvalidasi add-on, lalu `computeBoxCost` ditambah resep add-on. Potong stok otomatis dan HPP otomatis ikut.
3. Form order (pelanggan & admin): setelah memilih rasa, ada chip/checkbox add-on dengan harga (+Rp 5.000). Total berubah langsung.
4. Tampilan detail order, struk, WA/notifikasi, dan dashboard: "Box Besar · Cokelat + Vanila · +Keju, +Caramel".
5. Biteship: `value` item = `unit_price` (berat tetap per box).

### Fase D: Migrasi katalog rasa
Rasa gabungan dipecah menjadi rasa dasar + add-on:

| Varian sekarang | Menjadi |
|---|---|
| Choco / Vanilla / Greentea / Tiramisu / Strawberry | rasa dasar (tetap) |
| Choco Cheese, Vanilla Cheese, Greentea Cheese, Tiramisu Cheese, Strawberry Cheese | rasa dasar + add-on **Keju** |
| Caramel Cheese | ? (lihat pertanyaan) |
| Choco Oreo, Vanilla Oreo, … | ? Oreo tidak ada di daftar add-on |
| Milk Cheese, Choco Special | ? |

- Varian gabungan yang sudah pernah dipesan **tidak dihapus**, cukup dinonaktifkan (histori order tetap valid).
- Resep: gram Keju di resep "X Cheese" dipindah ke resep add-on Keju, sehingga resep rasa hanya berisi bahan rasanya.

## Pertanyaan yang perlu diputuskan
1. **Add-on berlaku per box atau per rasa?** Untuk Box Besar mix 3 rasa, apakah "+Keju" untuk seluruh box, atau bisa hanya untuk 1 dari 3 rasa? *Saran: per box (lebih sederhana untuk pelanggan dan dapur).*
2. **Harga add-on beda untuk Box Besar dan Box Kecil?** *Saran: ya (desain di atas mendukung). Gram add-on di Box Kecil otomatis ½.*
3. **Keju sebagai rasa dasar dan sekaligus add-on?** Kalau keduanya, pelanggan bisa memilih rasa Keju + add-on Keju. Boleh, atau dilarang?
4. **Oreo**, **Strawberry**, **Milk Cheese**, **Choco Special**, dan **Caramel Cheese** mau dijadikan apa?
5. **Maksimal add-on per box?** Tanpa batas atau maksimal N?
6. Bolehkah pelanggan memesan box **tanpa add-on**? (Asumsi: boleh, harga = harga box.)
7. Apakah **Milk (SKM)** memakai bahan stok "SKM" yang sudah ada? (Asumsi: ya.)

## Risiko
- Fase A menyentuh semua halaman yang menghitung omzet. Perlu diuji dengan data order yang ada.
- Form order pelanggan berubah. Uji di iPhone (ada pelajaran dari dropdown).
- Selama fase C belum rilis, WA bot/format pesan lama tetap berjalan dengan harga box saja.
