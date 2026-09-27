# Plan: Stok bersatuan (kemasan & perlengkapan)

Status: **✅ diimplementasi** (2026-09-27). Migration `1789842088778_create-packaging-rule` belum dijalankan di prod.

## Tujuan
Barang yang dihitung per buah ikut **terpotong otomatis** setiap ada order (dan kembali kalau order batal/diedit), serta ikut masuk **HPP / biaya order**, sama seperti bahan bergram.

## Keputusan
| Barang (nama di stok) | Satuan | Aturan pemakaian | Contoh |
|---|---|---|---|
| **Box Besar** | pcs | 1 per Box Besar (FULL) | 2 FULL → 2 |
| **Box Kecil** | pcs | 1 per Box Kecil (HALF), stok sendiri karena kemasannya berbeda | 1 HALF → 1 |
| **Garpu** | pcs | 1 per box, FULL maupun HALF | 2 FULL + 1 HALF → 3 |
| **Plastik Kuning** | pcs | 1 plastik untuk setiap 2 box (FULL maupun HALF): `ceil(jumlah box / 2)` | 1–2 box → 1 · 3–4 box → 2 · 5 box → 3 |
| **Sticker** | pcs | 1 per order | berapa pun boxnya → 1 |

- Biteship/pengiriman **tidak dibedakan** untuk sekarang (di-skip).
- Nama barang di stok memakai "Box Besar" dan "Box Kecil", sama seperti nama jenis box di menu. Di UI kemasan, keduanya selalu tampil di bawah judul "Kemasan" supaya tidak tertukar.

## Kondisi sekarang (yang sudah ada)
- `stock` mendukung satuan `pcs`. Harga modal "Rp 50.000 untuk 100 pcs" = Rp 500/pcs, dengan rata-rata tertimbang saat Stok Masuk.
- Potong stok otomatis (`stockDeduction.service.ts`): idempoten lewat `stock_history.order_id`, row lock pada order, dikembalikan dengan biaya aslinya saat batal, dan `recalculateOrderStock` saat order diedit.
- Resep rasa dan bahan dasar hanya menerima bahan bergram, dengan rumus porsi (HALF = ½). Rumus porsi **tidak** dipakai untuk kemasan.

## Desain data
Migration baru `packaging_rule`:

```
packaging_rule
  id            serial PK
  store_id      int  → stores   (CASCADE)
  stock_id      int  → stock    (CASCADE)
  box_type      varchar(10) NULL   -- 'FULL' | 'HALF' | NULL = semua jenis box
  mode          varchar(12)        -- 'per_box' | 'per_boxes' | 'per_order'
  qty           numeric(10,2) > 0  -- jumlah yang dipakai per satuan aturan
  boxes_per_unit int NULL          -- khusus 'per_boxes': 1 unit cukup untuk N box (N ≥ 2)
  created_at, updated_at
  unique (store_id, stock_id, box_type, mode)
  check  (mode <> 'per_boxes' OR boxes_per_unit >= 2)
```

Seed (migration, untuk setiap store):

| stock (dibuat kalau belum ada, stok 0, satuan pcs) | box_type | mode | qty | boxes_per_unit |
|---|---|---|---|---|
| Box Besar | FULL | per_box | 1 | |
| Box Kecil | HALF | per_box | 1 | |
| Garpu | NULL | per_box | 1 | |
| Plastik Kuning | NULL | per_boxes | 1 | 2 |
| Sticker | NULL | per_order | 1 | |

## Perhitungan
Semua perhitungan ada di fungsi murni `computePackagingUsage(rules, boxes)`. `boxes` berisi jumlah box per jenis dalam 1 order, misalnya `{ FULL: 2, HALF: 1 }`.

| mode | box yang dihitung | pemakaian |
|---|---|---|
| `per_box` | `box_type` tertentu, atau semua box kalau NULL | `qty × jumlah box` |
| `per_boxes` | idem | `qty × ceil(jumlah box / boxes_per_unit)` (0 box → 0) |
| `per_order` | order yang punya ≥ 1 box (atau ≥ 1 box jenis itu) | `qty` |

Contoh untuk order 2 FULL + 1 HALF (3 box): Box Besar −2, Box Kecil −1, Garpu −3, Plastik Kuning −2, Sticker −1.

### Potong stok otomatis
- `applyOrderStock` = pemakaian **bahan** (resep rasa + bahan dasar, sekarang) **+ kemasan**, digabung per `stock_id` lalu dibukukan dengan `bookMovement` yang sama (catatan `Order #id`, `unit_cost` = harga modal saat itu).
- Kemasan dihitung dari **semua item order**, termasuk item lama tanpa `variant_ids`, karena box fisiknya tetap dipakai.
- Batal: `reverseOrderStock` mengembalikan semua (bahan dan kemasan) tanpa perubahan kode.
- Edit order (qty/jenis box berubah): `recalculateOrderStock` menghitung ulang. Contoh: 2 box → 3 box, Plastik Kuning 1 → 2.
- Stok boleh minus, dan order tidak pernah diblokir (keputusan produk yang sama).

### HPP & biaya
- **HPP per box** (tampil di editor resep rasa): bahan + kemasan `per_box` untuk jenis box itu (Box Besar/Kecil + Garpu). Tampil sebagai rincian "Bahan Rp x · Kemasan Rp y".
- Kemasan `per_boxes` dan `per_order` (Plastik, Sticker) **tidak** dibagi ke HPP box. Keduanya masuk ke **biaya order** (`stock_cost` di order, yang otomatis sudah menjumlahkan semua mutasi order).
- Kartu Kemasan menampilkan perkiraan: "Biaya kemasan per order: 1 box ≈ Rp a · 2 box ≈ Rp b".

### Validasi & guard
- `qty > 0`. Untuk `per_boxes`, `boxes_per_unit` wajib bilangan bulat ≥ 2. `box_type` harus NULL/FULL/HALF.
- Barang harus milik store yang sama. Satuannya bebas (pcs, lembar, …).
- Satu barang boleh punya beberapa aturan, misalnya garpu 2 untuk FULL dan 1 untuk HALF. Kombinasi `(barang, box_type, mode)` harus unik.
- Barang yang dipakai di aturan kemasan **tidak bisa dihapus** (409: "Masih dipakai sebagai kemasan").

## API
| Method | Path | Isi |
|---|---|---|
| GET | `/packaging-rule?store_id=` | aturan + `item_name`, `unit`, `price_per_unit` |
| PUT | `/packaging-rule` | `{ store_id, items: [{ stock_id, box_type, mode, qty, boxes_per_unit }] }` mengganti semua aturan store |
| POST | `/packaging-rule/copy` | `{ from_store_id, to_store_id }`, barang dicocokkan dengan nama, yang belum ada dibuat (stok 0, satuan sama) |
| GET | `/variant-hpp` | (sudah ada) ditambah `packaging` di breakdown |

## UI
### `/config` → Varian & resep → kartu baru **"Kemasan & perlengkapan"** (di bawah "Bahan dasar semua box", per store)
```
Kemasan & perlengkapan                          Kalibata
─────────────────────────────────────────────────────────
Box Besar        1  per  [Box Besar ▾]                 🗑
Box Kecil        1  per  [Box Kecil ▾]                 🗑
Garpu            1  per  [Setiap box ▾]                🗑
Plastik Kuning   1  per  [Setiap 2 box ▾]              🗑
Sticker          1  per  [Order ▾]                     🗑
[+ Barang]  [Simpan]  [Salin ke Depok]
Biaya kemasan: 1 box ≈ Rp … · 2 box ≈ Rp … · 3 box ≈ Rp …
```
- Pilihan "per": **Box Besar**, **Box Kecil**, **Setiap box**, **Setiap N box** (input N muncul), dan **Order**.
- Dropdown barang: semua barang di store ini selain bahan dasar. Untuk kemasan, barang bergram tidak ditampilkan.
- Layout mobile mengikuti perbaikan iOS kemarin: dropdown mengambil sisa lebar, input qty lebarnya tetap, dengan chevron sendiri.
- Kalau ada barang tanpa harga modal: "Harga modal belum diisi: Garpu (dihitung Rp 0)".

### Lainnya
- **Stok**: tidak ada perubahan. Barang kemasan muncul di daftar dengan satuan pcs, dan Stok Masuk + harga beli sudah bisa dipakai.
- **Riwayat stok**: mutasi order kemasan tercatat "Order #id" dengan badge order, sama seperti bahan.
- **Editor resep rasa**: HPP menjadi "Box Besar Rp X (bahan Rp a + kemasan Rp b)".
- **Setup checklist**: langkah baru "Kemasan": jenis box aktif yang belum punya aturan `per_box` dengan box_type-nya memunculkan peringatan.

## Fase & langkah (semua ✅ kecuali Prod)
1. **Migration + seed**: `packaging_rule`, 5 barang pcs per store (dibuat kalau belum ada, dicocokkan dengan nama), dan aturan default di atas.
2. **Backend**:
   - `src/services/packaging.service.ts`: `computePackagingUsage` (murni), `getPackagingRules`, `replacePackagingRules`, `copyPackagingRules`.
   - `stockDeduction.service.ts`: `applyOrderStock` menggabungkan usage bahan + kemasan (`aggregateDeductions` diperluas).
   - `variantRecipe.service.ts`: `getVariantHpp` menambah kemasan `per_box` sesuai box_type.
   - `stock.service.ts`: guard hapus.
   - Route baru `packaging.route.ts`, didaftarkan di `routes/index.ts`.
   - `setup.service.ts`: langkah Kemasan.
3. **Test**:
   - Unit `computePackagingUsage`: 0/1/2/3/4/5 box untuk plastik, per_order, box_type filter, dan campuran FULL+HALF.
   - Integration:
     - Order 2 FULL + 1 HALF → Box Besar −2, Box Kecil −1, Garpu −3, Plastik −2, Sticker −1.
     - Edit ke 1 FULL → selisih kembali (Plastik jadi 1).
     - Batal → semua kembali dengan biaya asli.
     - Order tanpa aturan kemasan → hanya bahan.
     - Hapus barang kemasan → 409.
     - Salin ke store lain.
     - HPP FULL termasuk Box Besar + Garpu.
4. **Frontend**: `components/config/PackagingEditor.tsx`, pemasangan di `VariantManager`, rincian HPP di `VariantRecipeEditor`, dan setup checklist.
5. **Docs**: update `plan-setup-dari-nol.md` dan tandai langkah di dokumen ini ✅.
6. **Prod**: jalankan migration (seed otomatis), isi harga modal kelima barang, lalu Stok Masuk.

## Di luar scope (nanti)
- Aturan berbeda untuk order kirim (Biteship) vs ambil sendiri.
- Stok minimum & peringatan stok menipis (plan lama langkah 5), paling berguna untuk kemasan.
- Add-on (lihat `plan-addons.md`, ditunda).
