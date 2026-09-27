# Plan: Gaji harian bertingkat + masuk HPP

Status: **✅ diimplementasi** (2026-09-27). Migration `1789842089778_salary-per-store` perlu dijalankan di prod.

## Target perhitungan
Gaji pokok Rp 150.000 per hari (sudah termasuk 15 box pertama), lalu bonus per box bertingkat:

| Box ke- | Bonus per box |
|---|---|
| 1–15 | – (termasuk gaji pokok) |
| 16–20 | Rp 5.000 |
| 21–25 | Rp 6.000 |
| 26–30 | Rp 7.000 |

| Box/hari | Bonus | Total | Gaji per box |
|---|---|---|---|
| 15 | 0 | 150.000 | 10.000 |
| 20 | 5×5.000 = 25.000 | 175.000 | 8.750 |
| 25 | 25.000 + 5×6.000 = 55.000 | 205.000 | 8.200 |
| 30 | 25.000 + 30.000 + 5×7.000 = 90.000 | 240.000 | 8.000 |

## Kondisi sekarang
- Tabel `salary_config (min_box, max_box, amount, is_fixed)` dan mesin hitung progresif di `salary.service.ts` **sudah mendukung** model ini. Yang perlu hanya konfigurasi yang benar:
  ```
  (0, 15, 150000, fixed)   (16, 20, 5000)   (21, 25, 6000)   (26, 30, 7000)
  ```
- ⚠️ **Konfigurasi di prod sekarang salah.** Isinya `15–20 = 175.000/box`, `21–25 = 205.000/box`, dan `26–30 = 240.000/box`: yang diisi adalah *total gaji*, padahal kolom itu *bonus per box*. Akibatnya 20 box dihitung 6 × 175.000 = **Rp 1.050.000**. Form sekarang mudah disalahpahami.
- Kekurangan lain:
  1. **Tidak per store.** `daily_salary` unik per tanggal, dan box dihitung dari semua store digabung. Kalibata 20 + Depok 15 = 35 box → satu gaji.
  2. Box dihitung dari order `PAID`/`DONE` berdasarkan `pickup_date`, dengan HALF = 0,5 lalu dibulatkan ke atas.
  3. Rincian per tingkat (seperti contoh di atas) tidak ditampilkan. Hanya totalnya.
  4. Tidak ada validasi tingkat: bisa ada celah atau tumpang tindih.
  5. Gaji belum masuk HPP maupun laporan keuangan (`finance.service` hanya menghitung `pengeluaran`).

## Keputusan (2026-09-27, revisi 2)
- ✅ Konfigurasi gaji: `0–15 = 150.000 (fixed)`, `16–20 = 5.000`, `21–25 = 6.000`, `26–30 = 7.000`. **Lebih dari 30 box tetap Rp 240.000.**
- ✅ Box Kecil = ½ box, total dibulatkan ke atas. Status order yang dihitung: PAID + DONE.
- ✅ **1 orang per store per hari. Gaji terpisah per store**, termasuk **Depok** (walau sekarang dikerjakan pemilik, gajinya tetap dihitung dan dicatat).
- ✅ Gaji harian **dicatat otomatis di Pengeluaran** per store. Gaji tidak lagi dicatat manual.
- ✅ **Laporan keuangan dipisah per store.**
- ✅ **HPP tenaga kerja bisa memakai store lain sebagai acuan** (flag). Depok memakai acuan Kalibata.

## Desain final
### Data (1 migration)
| Tabel | Perubahan |
|---|---|
| `salary_config` | + `store_id` NOT NULL. Konfigurasi yang ada **diduplikasi untuk setiap store** (Kalibata & Depok mulai dengan tingkat yang sama, lalu bisa diubah terpisah). |
| `daily_salary` | + `store_id` NOT NULL, + `breakdown jsonb`. Unique `(date)` → `(date, store_id)`. (Belum ada data.) |
| `pengeluaran` | + `store_id` (NULL = biaya umum, tidak terikat store), + `daily_salary_id` FK unique `ON DELETE CASCADE`. (Belum ada data.) |
| `stores` | + `labor_target_boxes int` (default 30), + `labor_reference_store_id int NULL → stores` (**flag acuan HPP**: NULL = pakai gaji store sendiri, isi = pakai store itu). |

Setelah migration: Depok `labor_reference_store_id = Kalibata`.

### Perhitungan
- `computeSalary(tiers, boxes)` (fungsi murni) → `{ total, lines[] }`. Contoh 20 box: `[1–15 gaji pokok 150.000] [16–20: 5 × 5.000 = 25.000]` = 175.000.
- `calculateSalaryPreview(date, store_id)`: box units order PAID/DONE store itu pada `pickup_date`, dibulatkan ke atas, lalu tingkat store itu.
- `generateDailySalary(date, store_id)` dalam 1 transaksi: upsert `daily_salary` lalu upsert pengeluaran tertaut (`name = "Gaji harian <store> <tgl>"`, `category = "Gaji"`, `store_id`, `price = total`). Generate ulang memperbarui baris yang sama, jadi tidak dobel.
- **HPP tenaga kerja** store S: `R = S.labor_reference_store_id ?? S`, lalu `per box = gaji_R(target_R) / target_R`. Kalibata target 30: 240.000 / 30 = **Rp 8.000 per Box Besar, Rp 4.000 per Box Kecil** (× porsi box). Depok (acuan Kalibata): nilai yang sama.
  `getVariantHpp` menambah `hpp_labor` dan `labor_reference`. Tampilan: `Box Besar Rp X (bahan a + kemasan b + tenaga kerja c · acuan Kalibata)`.

### Laporan keuangan per store
- `GET /finance/summary?start&end&store_id` (tanpa `store_id` = semua store):
  - omzet dan jumlah box dari order store itu;
  - pengeluaran store itu (termasuk gaji otomatis);
  - biaya umum (`store_id` NULL) ditampilkan **terpisah** dan hanya ikut dijumlah di tampilan "Semua store";
  - info tambahan: HPP bahan & kemasan terjual (Σ `stock_cost`), **tidak** dijumlah ke biaya supaya tidak dobel dengan belanja bahan di pengeluaran;
  - modal dan hutang tetap angka usaha keseluruhan (tidak per store).
- `GET /pengeluaran?store_id=` dan `POST /pengeluaran` menerima `store_id`.
- Frontend:
  - `/summary`: Store Switcher (Semua / Kalibata / Depok).
  - `/cashflow`: filter store sekarang juga memfilter pengeluaran, dan form pengeluaran punya pilihan store (default store aktif, atau "Umum").
  - Baris gaji otomatis ditandai "otomatis dari Gaji" dan tidak bisa diedit dari cashflow.

### Gaji UI
- `/config/salary`: Store Switcher, form gaji pokok (Rp, termasuk N box) + bonus bertingkat (batas bawah otomatis, validasi tanpa celah), simulasi 15/20/25/30/35 box, dan tombol **"Salin ke <store lain>"**.
- `/salary`: Store Switcher, preview dengan rincian per tingkat, generate (+ pengeluaran otomatis), riwayat per store dengan gaji per box.
- **Tab Store** (`/config?tab=store`): "Target box per hari (untuk HPP)" dan **"Acuan tenaga kerja HPP"** (Store ini sendiri / Kalibata / …).

### Fase
1. Migration + `computeSalary` + validasi tingkat + unit test (0/15/16/20/25/30/35 box).
2. Gaji per store: service/route, pengeluaran otomatis, integration test (generate dua kali tidak dobel; store lain terpisah).
3. HPP tenaga kerja + flag acuan, integration test (Depok memakai Kalibata).
4. Laporan keuangan & pengeluaran per store, integration test (biaya umum tidak masuk store).
5. Frontend (`/config/salary`, `/salary`, tab Store, HPP editor, `/summary`, `/cashflow`) + docs.

---
*Bagian di bawah adalah analisis awal; bila berbeda, yang berlaku adalah "Desain final" di atas.*

## Desain
### Data
```
salary_config    + store_id int NULL → stores   (NULL = berlaku untuk semua store)
daily_salary     + store_id int NOT NULL → stores
                 + breakdown jsonb      -- rincian per tingkat, untuk ditampilkan
                 unique (date) → unique (date, store_id)
stores           + labor_target_boxes int NULL   -- asumsi box/hari untuk HPP (lihat bawah)
```
Konfigurasi prod diganti dengan 4 baris di atas.

### Perhitungan (fungsi murni `computeSalary(tiers, boxes)`)
Hasilnya `{ total, lines: [{ from, to, boxes, rate, amount, fixed }] }`, dipakai untuk preview, generate, dan simulasi:
```
20 box → [ {1–15, gaji pokok, 150.000}, {16–20, 5 × 5.000 = 25.000} ]  total 175.000
```
- Box per hari **per store** = Σ box units order `PAID`/`DONE` dengan `pickup_date` = tanggal itu (HALF = 0,5), dibulatkan ke atas.
- Validasi saat simpan konfigurasi: tingkat pertama mulai dari 0 atau 1 dan fixed (gaji pokok), tiap tingkat berikutnya mulai tepat setelah tingkat sebelumnya (tanpa celah atau tumpang tindih), hanya tingkat terakhir yang boleh tanpa batas atas, dan nominal ≥ 0.

### HPP: dua sudut pandang
Gaji tidak tergantung rasa. Gaji tergantung **berapa box terjual hari itu**, jadi biaya per box turun kalau penjualan naik (10.000 → 8.000). Karena itu:

1. **HPP perkiraan (di editor resep)**: `tenaga kerja per box = gaji(target) / target`, dengan `target = stores.labor_target_boxes`. Default 30 kalau kosong (bisa diubah di tab Store).
   - Box Besar: Rp 8.000 (target 30). Box Kecil: × porsi box (½) = Rp 4.000, konsisten dengan hitungan box units.
   - Tampilan: `Box Besar Rp X (bahan Rp a + kemasan Rp b + tenaga kerja Rp c)`.
   - Ada tabel kecil "kalau jual 15 / 20 / 25 / 30 box per hari → Rp 10.000 / 8.750 / 8.200 / 8.000 per box".
2. **HPP aktual (per hari, di halaman Gaji dan Keuangan)**: `gaji hari itu / box hari itu`, dari `daily_salary`.
   - `/finance` (ringkasan mingguan): tambah **Biaya bahan & kemasan** (Σ `stock_cost` order) dan **Gaji** (Σ `daily_salary`), lalu laba kotor = omzet − bahan − gaji − pengeluaran lain.
   - ⚠️ Kalau selama ini gaji juga dicatat manual di `pengeluaran`, akan terhitung **dua kali**. Lihat pertanyaan 4.

### UI
- **`/config/salary`** (dirapikan, per store):
  ```
  Gaji pokok         Rp [150.000]  sudah termasuk [15] box pertama
  Bonus per box
    Box 16 – [20]    Rp [5.000] / box
    Box 21 – [25]    Rp [6.000] / box
    Box 26 – [30]    Rp [7.000] / box      [+ Tingkat]
  Simulasi: 15 box Rp 150.000 · 20 box Rp 175.000 · 25 box Rp 205.000 · 30 box Rp 240.000
  ```
  Batas bawah tiap tingkat terisi otomatis dari tingkat sebelumnya, sehingga tidak mungkin ada celah. Kolom yang mudah salah seperti "is_fixed" disembunyikan.
- **`/salary`**: memakai Store Switcher. Preview menampilkan rincian per tingkat seperti contoh, dan riwayat per store menampilkan "gaji per box".
- **Tab Store**: isian "Target box per hari (untuk HPP)".

## Fase
1. **Perbaiki konfigurasi & tampilan** (paling mendesak karena angka di prod salah):
   - `computeSalary` murni + validasi tingkat + unit test dengan angka contoh (15/20/25/30, 0 box, 35 box).
   - Form baru `/config/salary` dan simulasi.
   - Ganti konfigurasi prod dengan 4 tingkat di atas.
2. **Per store**: migration `store_id` di `salary_config` dan `daily_salary` (+ `breakdown`), preview/generate per store, dan Store Switcher di `/salary`.
3. **HPP perkiraan**: `stores.labor_target_boxes`, `getVariantHpp` menambah `hpp_labor`, dan tampilan di editor resep dan tab Store.
4. **Keuangan aktual**: `/finance` menampilkan biaya bahan & kemasan dan gaji. Gaji per box juga tampil di riwayat gaji.
5. Test integration + docs.

## Pertanyaan
1. **Lebih dari 30 box**: bonusnya berapa per box? Tetap Rp 7.000, tingkat baru (sekarang ada `31+ = 3.000` di seed lama), atau 30 memang maksimal (kuota)?
2. **Box Kecil dihitung ½ box** untuk gaji (seperti sekarang), atau 1 box?
3. **Gaji per store atau per orang?** Apakah setiap store punya 1 orang per hari, atau bisa lebih (gaji dibagi / per orang)?
4. **Apakah gaji selama ini dicatat juga di Pengeluaran?** Kalau ya, saat gaji masuk laporan keuangan, gaji di pengeluaran perlu dikecualikan atau dihentikan supaya tidak dobel.
5. Box yang dihitung: order **PAID dan DONE** saja (seperti sekarang), atau termasuk UNPAID yang sudah diambil?
6. **Target box per hari** untuk HPP perkiraan: 30 untuk kedua store?
