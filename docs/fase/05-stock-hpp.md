# Fase 05: Stock C, HPP

**Status:** ✅ kode selesai · ⏳ migrate + deploy oleh user
**Referensi:** [design doc](../plan-stock-bahan-baku.md) Fitur 2 · [plan implementasi](../plan-implementasi-stock-bahan-baku.md) Fase C

## Migration
- [x] `1789842082778_add-price-to-stock.js`: `stock.price_per_unit numeric(12,4)` dan `stock_history.total_price numeric(12,2)`. Diuji di Postgres lokal.

## Backend
- [x] `adjustStock` menerima `total_price` opsional:
  - Hanya boleh untuk stok masuk (`type = 'IN'`, bukan mode hitung fisik) dengan penambahan > 0; selain itu 400.
  - Di transaksi yang sama: `price_per_unit = total_price / qty_masuk` (harga pembelian terakhir yang dipakai) dan `stock_history.total_price` ikut disimpan.
  - Stok masuk tanpa harga mempertahankan `price_per_unit` sebelumnya (`COALESCE`).
- [x] `computeHpp(usage, stocks)` (fungsi murni) dan `getVariantHpp(variantIds, boxType, storeId)`.
- [x] `GET /variant-hpp?variant_ids=1,2&box_type=FULL|HALF&store_id=1` mengembalikan `{ hpp, breakdown[{stock_id, item_name, qty_gram, price_per_unit, subtotal}], missing_price[] }`. Bisa untuk 1 rasa, campuran beberapa rasa, maupun paket mix.

## Frontend
- [x] `/stock`:
  - Mode "Stok Masuk (IN)" punya field "Total Harga Beli (Opsional)" dengan preview "≈ Rp …/gram".
  - Daftar stok menampilkan `Rp …/unit` kalau sudah ada harga.
  - Pesan error dari backend sekarang ditampilkan di toast.
- [x] `/config` → panel "Resep" per variant:
  - Kotak "HPP bahan baku Full / Half", dihitung dari resep yang **tersimpan** dan dimuat ulang setiap kali resep atau komponen disimpan.
  - Peringatan kalau ada bahan yang harga belinya belum diisi.
  - Untuk paket mix, HPP dihitung dari komponennya.

## Verifikasi
- [x] Unit test `computeHpp` (3 test), termasuk contoh dari design doc: 50 g × Rp 140 = **Rp 7.000** (FULL) dan **Rp 3.500** (HALF).
- [x] Integration test: stok masuk 5000 g seharga Rp 700.000 menghasilkan `price_per_unit = 140`; stok masuk tanpa harga mempertahankan harga lama; harga untuk OUT atau mode hitung fisik ditolak; `getVariantHpp` menghasilkan 7000/3500; `stock_history.total_price` tersimpan.
- [x] `npm run test:db`: **70 test lulus**. Frontend: `tsc` bersih, lint 199.

## Deploy (user)
- [ ] `npm run migrate up` dan deploy backend, lalu frontend.
- [ ] Input stok masuk dengan total harga, lalu cek HPP di `/config` → Resep.

## Catatan pengerjaan
- Keputusan desain: HPP ditampilkan dari resep **tersimpan**, bukan dari isian form yang belum disimpan, supaya angka yang terlihat selalu sama dengan yang dipakai sistem.
- Halaman riwayat stok (`/stock/[id]/history`) belum menampilkan `total_price`. Tambahan kecil, bisa dikerjakan kapan saja.
