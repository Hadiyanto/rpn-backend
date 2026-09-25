# Fase 04: Stock B, fondasi frontend (checkpoint deploy)

**Status:** ✅ kode selesai · ⏳ deploy + isi resep oleh user
**Referensi:** [plan implementasi](../plan-implementasi-stock-bahan-baku.md) Fase B, gap G2/G2b/G6/G7

## Frontend
- [x] `types/menu.ts`: `Menu.box_multiplier?` dan `Menu.max_flavors?`; `Variant.component_ids?`. Tipe `OrderItem` di tiap halaman sekarang punya `variant_ids?`.
- [x] `utils/flavors.ts` (baru):
  - `isPresetVariant`: ada `component_ids`, atau (fallback) nama berawalan "Mix 3".
  - `selectedVariants`: berdasarkan id kalau ada, kalau tidak dicocokkan dari nama (untuk order lama).
  - `buildSelection`: format nama "Mix A Dan B" dengan urutan sama seperti `.sort()` lama.
  - `resolveVariantIds`: dipakai saat submit.
  - `maxFlavorsFor(menus, boxType)`: fallback FULL 3, HALF 1.
- [x] `components/FlavorPicker.tsx` (baru): menggantikan 3 blok IIFE yang terduplikasi di `app/page.tsx`, `app/pesan/page.tsx`, dan `app/orders/page.tsx`. Prop `showImages` dan `radiusClass` menjaga tampilan `/orders` yang lebih ringkas (tanpa gambar, `rounded-lg`).
- [x] Batas rasa di ketiga halaman sekarang dari `menu.max_flavors`, termasuk label "Pilih Rasa (Max N …)".
- [x] Submit `app/page.tsx` dan `app/pesan/page.tsx` mengirim `variant_ids` (dan tidak lagi mengirim field UI `isExpanded`). `app/orders/page.tsx` create dan edit juga mengirim `variant_ids`. Form edit memuat `variant_ids` dari order.
- [x] Ganti tipe box: di halaman publik dan `/pesan` pilihan direset (`variant_ids: []`). Di `/orders`, pindah ke HALF menyimpan rasa pertama saja; perilaku lama dipertahankan, sekarang juga untuk id.
- [x] `app/stock/page.tsx`: tab per store, `GET /stocks?store_id=`, dan modal "Tambah Bahan" (nama, satuan gram/ml/pcs/kg/liter, stok awal) dengan catatan bahwa hanya bahan gram yang bisa dipakai di resep.
- [x] `app/config/page.tsx`:
  - Kartu menu punya input "Porsi resep" (`box_multiplier`) dan "Maks rasa" (`max_flavors`).
  - Kartu variant punya tombol "Resep" untuk membuka `components/VariantRecipeEditor.tsx` (baru). Isinya: pilih komponen paket mix; resep per 1 Full Box untuk store aktif (dropdown hanya menampilkan stok bersatuan gram di store itu, input gram, hapus/tambah baris, simpan). Varian berkomponen mendapat badge "Paket" dan tidak punya resep sendiri.

## Backend
- [x] `validateOrderItems` menerima `variant_ids` opsional: array integer ≥ 1. Array kosong dianggap tidak dikirim.
- [x] `createOrder` dan `updateOrder` memanggil `assertVariantSelections` (memakai `checkVariantSelection` + `loadVariantCatalog`) **sebelum** menyentuh Redis. Helper `insertOrderItems` menulis `order_items` dan `order_item_variants` dalam transaksi yang sama.
- [x] `getOrders` dan `getOrderById` menambahkan `variant_ids` per item lewat 1 query `pg` terpisah (`attachVariantIds`). Embed PostgREST sengaja tidak dipakai supaya tidak bergantung pada refresh cache skema Supabase. Item lama mendapat `[]`.
- [x] `getOrderById` dipindah ke `pg` (bagian dari Fase 10, dikerjakan lebih awal supaya bisa diuji). Bentuknya sama: baris order + `items[{id, box_type, name, qty}]`. Kalau tidak ditemukan tetap throw, seperti `.single()` dulu.
- [x] `config/db.ts`: parser `TIMESTAMP` mengembalikan string format supabase-js (`YYYY-MM-DDTHH:mm:ss…`), supaya tampilan waktu di frontend tidak bergeser.
- [x] Item tanpa `variant_ids` tetap diterima (G7).

## Verifikasi
- [x] Integration test `src/services/__tests__/order.integration.test.ts` (6 test, Postgres lokal + Redis palsu in-memory):
  - `variant_ids` tersimpan dan terbaca kembali; `pickup_date` berupa string;
  - cache kosong di-warm dari DB (10 − 4 − 0.5×2 = 5);
  - tanggal tanpa kuota ditolak;
  - pilihan tidak valid ditolak **sebelum** Redis tersentuh;
  - item lama tanpa id;
  - `updateOrder` atomik: edit tidak valid tidak mengubah apa pun, termasuk header.
- [x] `npm run test:db`: **66 test lulus**. `vitest.config.ts` memakai `fileParallelism: false` karena file integration test berbagi satu DB.
- [x] Frontend: `tsc --noEmit` bersih; lint **199** masalah (baseline 205); `npm run build` sukses. `public/js/sw.js` yang ditulis ulang oleh build dikembalikan.

## Deploy (user): checkpoint
- [ ] `npm run migrate up` (Fase 03), lalu deploy backend, lalu frontend.
- [ ] Buat order test lewat UI, lalu cek `SELECT * FROM order_item_variants ORDER BY id DESC LIMIT 5;`.
- [ ] Di `/stock`, per store: tambahkan bahan bersatuan gram. Di `/config`: isi komponen untuk paket "Mix 3" dan resep tiap rasa. Cek juga "Maks rasa" FULL (K4).

## Catatan pengerjaan
- ⚠️ **Insiden kecil saat testing:** versi pertama integration test sempat memanggil `getOrderById` versi supabase-js, yang membaca URL/key dari `.env`, sehingga ada **query SELECT ke Supabase produksi** (tidak ada penulisan; data asli yang terbaca hanya nama satu order). Sudah diperbaiki: `useTestDb()` sekarang menimpa `SUPABASE_URL`/`SUPABASE_KEY` dan `UPSTASH_*` dengan alamat tidak valid, dan test yang butuh Redis memakai `fakeRedis`.
- **Perubahan perilaku:** `/pesan` dan `/orders` sebelumnya membatasi FULL ke 2 rasa. Sekarang mengikuti `menu.max_flavors` (seed 3). Kalau K4 = 2, cukup ubah "Maks rasa" FULL di `/config`.
- Filter hari di `getOrders` (`d.getDay()` pada server UTC) kemungkinan bergeser satu hari; dicatat untuk Fase 07.
