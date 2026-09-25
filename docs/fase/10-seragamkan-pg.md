# Fase 10: Seragamkan akses DB ke `pg` (+ RLS)

**Status:** ✅ kode selesai · ⏳ deploy + aktifkan RLS oleh user

## Langkah kode
- [x] Fondasi (dikerjakan bertahap sejak Fase 02–04), di `config/db.ts`:
  - Type parser `DATE` → `'YYYY-MM-DD'`, `NUMERIC` → number, dan `TIMESTAMP` → `'YYYY-MM-DDTHH:mm:ss…'`. Ketiganya identik dengan format JSON PostgREST/supabase-js.
  - Helper `insertRow` / `updateRowById`: membuang key `undefined` seperti supabase-js, dan nama kolom hanya berasal dari kode.
- [x] Semua service sekarang memakai `pg`:
  - order (`getOrders`, `getOrderById`, `updateOrderStatus`, `updatePaymentMethod`)
  - dailyQuota, hourlyQuota
  - salary, capital, debt, finance
  - menu, variant, store
  - push, userRole, penjualan, pengeluaran, transaction
  - `health.ts`
  - Tidak ada lagi import `config/supabase` di `src/`.
- [x] Perbaikan yang ikut masuk:
  - `updateSalaryConfig`: hapus + insert dalam **satu transaksi**. Dulu, kalau insert gagal, semua konfigurasi gaji terhapus.
  - `createTransaction` (POS): header dan baris penjualan dalam satu transaksi, plus advisory lock supaya checkout paralel tidak mendapat `order_number` yang sama. Dulu bisa dobel, dan header bisa tersimpan tanpa baris.
  - `calculateSalaryPreview` dan `getWeeklySummary` dihitung dengan agregat SQL (HALF = 0.5 lewat `BOX_UNITS_SQL`).
  - `getPenjualanByTransaction`: embed `variant(variant_name)` dihapus karena kolom `variant` sudah berupa teks tanpa FK sejak migration `1770489100000`, sehingga query lama kemungkinan besar selalu error. Sekarang mengembalikan `menu: { name }` dan kolom `variant` apa adanya.
  - `getUserRole`: id yang bukan UUID → role default (sama seperti dulu, ketika supabase-js mengembalikan error lalu null).
  - `/health` tidak lagi mengirim pesan error DB ke client.
- [x] `utils/errors.ts` `sendError` memetakan kode error Postgres akibat input ke 4xx dengan pesan aman: 23505 → 409 "Data sudah ada"; 23503, 23514, 23502, 22P02, 22007, 22008, 22003 → 400. Dengan begitu, pelanggaran constraint (misalnya `payment_method` tidak valid) tetap 4xx seperti dulu, tanpa membocorkan nama constraint.
- [x] `config/supabase.ts` **dipertahankan**. Masih dipakai `import_variants.ts` dan `update_roles.ts` di root, dan disiapkan untuk auth nanti.

## Verifikasi
- [x] `src/services/__tests__/pgServices.integration.test.ts` (8 test) memeriksa bentuk response dan perilaku di Postgres lokal:
  - capital/debt CRUD: angka sebagai number, update parsial tidak menimpa kolom lain, 404;
  - pengeluaran: tanggal default;
  - POS: 5 checkout paralel → RPN-0000001…0000005 tanpa duplikat; baris gagal → header ikut batal; embed menu;
  - salary: replace gagal → konfigurasi lama tetap ada; preview 2 FULL + 3 HALF = 3.5 → dibulatkan 4 → Rp 20.000; upsert harian;
  - finance: ringkasan dari agregat;
  - menu/variant/store: update parsial dan 404;
  - kuota: tanggal duplikat → 23505; `getOrders` dengan filter status/store/hari dan bentuk `items`; `payment_method` tidak valid → 23514;
  - user role dan push subscription upsert.
- [x] `src/utils/__tests__/errors.test.ts`: pemetaan kode Postgres.
- [x] `npm run test:db`: **105 test lulus**; `tsc --noEmit` bersih.

## Langkah user
- [ ] Deploy backend, lalu cek halaman-halaman utama: `/orders`, `/config`, `/stock`, `/finance`, `/cashflow`, `/salary`, `/sales`, dan halaman order publik.
- [ ] **Setelah** backend baru stabil, aktifkan RLS di Supabase (SQL editor). Frontend hanya memakai Supabase untuk **auth** (`signInWithPassword`, `getUser`, `signOut`), sedangkan backend tersambung lewat `DATABASE_URL` sebagai pemilik tabel, jadi keduanya tidak terpengaruh. Setelah RLS aktif, anon key yang ada di bundle frontend tidak bisa lagi membaca tabel:
  ```sql
  DO $$
  DECLARE t text;
  BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
  END $$;
  ```
  Tanpa policy, RLS berarti "tolak semua" untuk role `anon`/`authenticated`.
- [ ] Setelah RLS aktif, script root `import_variants.ts` dan `update_roles.ts` (yang memakai anon key) tidak akan berfungsi lagi. Kalau masih dibutuhkan, jalankan dengan service-role key atau pindahkan ke `pg`.

## Catatan pengerjaan
- Belum dibandingkan langsung dengan response Supabase produksi (sesuai aturan, test tidak menyentuh produksi). Kesamaan format dijamin oleh parser tipe di atas, yang mengikuti format JSON bawaan Postgres yang juga dipakai PostgREST. Pengecekan manual setelah deploy tetap disarankan.
- Ada dua client Upstash (`src/config/redis.ts` dan `src/utils/redis.ts`); belum disatukan.
