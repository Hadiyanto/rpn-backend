# Plan perbaikan issue hasil review

> **Status eksekusi:** lihat [`fase/README.md`](./fase/README.md). Fase 1–7 di dokumen ini dikerjakan sebagai fase 01, 02, dan 07–11 di sana.

Scope: semua temuan review **kecuali auth backend** (sengaja ditunda). Kredensial di `docker-compose.yml` & `.env.example` root sudah diganti placeholder; `rpn-backend/.env` dan `rpn-frontend/.env.local` tetap dipakai untuk run lokal (sudah di-ignore git).

Urutan fase = urutan prioritas. Tiap fase bisa di-deploy sendiri.

---

## Fase 1 — Validasi input order publik (kecil, dampak besar)

**Masalah:** `qty` tidak divalidasi. `qty: -100` membuat `redis.incrbyfloat(key, -requestedBoxQty)` justru *menambah* kuota, dan order dengan qty negatif/pecahan masuk DB.

**Perubahan — `src/services/order.service.ts`:**
- Buat helper `validateOrderItems(pesanan)` dipakai oleh `createOrder` **dan** `updateOrder`:
  - `pesanan` harus array, 1–20 item.
  - `qty`: `Number.isInteger(qty) && qty >= 1 && qty <= 50` (batas atas bisa disesuaikan).
  - `box_type` ∈ FULL/HALF/HAMPERS (pindahkan validasi yang sekarang terduplikasi ke sini).
  - `name` string non-kosong, maks 255 char.
- `pickup_date` harus format `YYYY-MM-DD` valid dan tidak di masa lalu (WIB).
- `pickup_time` opsional, format `HH:mm` atau `HH:mm - HH:mm`.
- `customer_phone` normalisasi via `formatWAPhone` + regex digit 9–15.

**Verifikasi:** POST `/api/order` dengan qty `-1`, `0`, `1.5`, `"abc"` → 400; qty `1` → sukses.

---

## Fase 2 — Bug kuota Redis

### 2a. Cache warming harian menghitung dari kuota penuh (risiko overbooking)
`dailyQuota.service.ts` (`getDailyQuotas` baris ~43 dan `getDailyQuotaByDate` ~98): saat key Redis `null`, cache diisi `remaining_qty = qty` tanpa mengurangi order yang sudah ada.

**Perubahan:**
- Ekstrak query di `syncDailyRedisQuota` (`dailyQuota.service.ts:199`) jadi `computeRemainingDailyFromDb(store_id, date)` → `{ remaining_box, remaining_hampers }`.
- Pakai fungsi ini di semua jalur warming (`SET NX`) dan di `syncDailyRedisQuota` sendiri.

### 2a-bis. `syncDailyRedisQuota` menghitung HALF = 1 box
Query di `dailyQuota.service.ts:207` menjumlahkan `oi.qty` untuk FULL **dan** HALF, sedangkan `createOrder` menghitung HALF = 0.5. Akibatnya setiap kali sync jalan (cancel / un-cancel / edit order), sisa kuota jadi lebih kecil dari seharusnya → tanggal bisa tampil "penuh" padahal belum.
- Ganti jadi `CASE WHEN box_type='HALF' THEN qty*0.5 WHEN box_type='FULL' THEN qty ELSE 0 END` (idealnya pakai `menu.box_multiplier` begitu kolom itu ada — lihat plan stock).
- `parseInt` → `parseFloat` (hasil sekarang bisa pecahan).
- `to_char(o.pickup_date,'YYYY-MM-DD') = $1` → `o.pickup_date = $1::date` supaya index `pickup_date` terpakai.
- Cek `hourlyQuota.service.ts` `syncHourlyRedisQuota` untuk bug yang sama.

### 2b. `createOrder` pada cold cache
Kalau key belum ada, `incrbyfloat` mulai dari 0 → order ditolak "penuh", lalu revert meninggalkan key `0` **tanpa TTL** yang tidak akan ditimpa oleh `SET NX`.

**Perubahan:** di `createOrder`, sebelum decrement harian, `mget` kedua key; kalau `null` → warm dulu pakai `computeRemainingDailyFromDb` + `SET NX EX ttlUntilDate(date)`. Kalau tidak ada baris `daily_quota` untuk tanggal itu → tolak dengan pesan "tanggal belum dibuka" (perilaku sekarang secara efektif sama, tapi eksplisit).

**Opsional (lebih kuat):** pindahkan cek+decrement ke satu Lua script (`redis.eval`) supaya "cek ≥ 0 lalu kurangi" atomik tanpa perlu revert.

### 2c. Hapus blok restore kuota legacy
`src/routes/order.route.ts:163-191` memakai key `quota:${pickup_date}` (tanpa `store_id`) — salah key dan redundan, karena `updateOrderStatus` sudah memanggil `syncDailyRedisQuota` + `syncHourlyRedisQuota`. Hapus seluruh blok. Setelah deploy, bersihkan key yatim: `SCAN` pola `quota:20*` & `quota:hampers:20*` (format lama) lalu `DEL`.

### 2d. `updateOrder` tidak atomik & melewati validasi kuota
Header di-update via supabase-js, item via `pg` transaction terpisah.

**Perubahan:**
- Tulis ulang `updateOrder` sepenuhnya pakai `transaction(client => ...)`: `SELECT ... FOR UPDATE` order → `UPDATE orders` → `DELETE/INSERT order_items`.
- Setelah commit, sync kuota (sudah ada). Tambahkan cek: kalau setelah sync `remaining < 0` untuk tanggal/jam baru → kembalikan warning di response (admin tetap boleh overbook secara sadar; ini endpoint admin).

**Verifikasi fase 2:**
- `redis-cli DEL quota:1:<tgl>` lalu buka `/api/daily-quota` → remaining = qty − terpakai (bukan qty penuh).
- Order pertama untuk tanggal dengan cache kosong → sukses, bukan "penuh".
- Cancel order → remaining naik tepat 1×; cancel ulang (status sama) → tidak berubah.

---

## Fase 3 — Timezone & data hardcode

| Lokasi | Masalah | Perbaikan |
|---|---|---|
| `order.route.ts` blok Biteship (`isToday`, `todayLocal`) | Pakai timezone server (Render = UTC) | Helper `todayWIB()` di `src/utils/date.ts` (`toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' })`), bandingkan string `YYYY-MM-DD` |
| `order.route.ts` blok WA PAID (`new Date(y, m-1, d).toLocaleDateString`) | Sama | Tambah `timeZone: 'Asia/Jakarta'` / pakai helper yang sama |
| `order.route.ts` Biteship `value: 50000` | Nilai barang hardcode | Ambil `menu.price` per `box_type` |
| `order.route.ts` total WA: `menuMap.get(p.box_type)` via `SELECT name, price FROM menu` | Cocok hanya kalau `menu.name` persis FULL/HALF/HAMPERS | Buat `getMenuPriceMap()` di `menu.service.ts`, filter `is_active`, dipakai WA + Biteship |
| `rpn-frontend/utils/config.ts` `BCA_ACCOUNT_*`, `ORIGIN_AREA_ID` | Hardcode padahal sudah multi-store | Migration tambah `bank_name`, `bank_account_number`, `bank_account_name` ke `stores`; FE ambil dari store terpilih. `ORIGIN_AREA_ID` → pakai `stores.area_id` |

---

## Fase 4 — Refactor order route

`PATCH /order/:id/status` ±200 baris, memanggil `getOrderById` sampai 3×.

- Buat `src/services/orderEvents.service.ts` dengan `onOrderCreated(order)`, `onOrderPaid(order)`, `onOrderDone(order)`.
  - `onOrderPaid` = kirim WA PAID + `createBiteshipDispatch(order)` (pindahkan ke `src/services/biteship.service.ts`).
- Route cukup: validasi → `updateOrderStatus` → `getOrderById` **1×** → panggil event handler secara fire-and-forget (`.catch(log)`), lalu `res.json`.
- `return res.json(...)` di tengah blok Biteship (early return) ikut hilang — alur jadi linear dan mudah dibaca.
- **Idempotensi Biteship:** simpan `biteship_order_id` di `orders` (migration baru); skip kalau sudah terisi, supaya PAID→UNPAID→PAID tidak membuat 2 dispatch.

---

## Fase 5 — Hardening ringan (tanpa auth)

- **Rate limit** `src/index.ts`: jangan skip `/api/menu`, `/api/variants`, `/api/daily-quota`, `/api/hourly-quota` sepenuhnya — beri limiter terpisah yang lebih longgar (mis. 300/menit/IP) daripada tanpa batas.
- **Error ke client:** buat error handler Express terpusat; kirim `e.message` hanya untuk error bisnis (buat class `AppError`), sisanya "Terjadi kesalahan server" + log detail di server.
- **Pool DB** `src/config/db.ts`: `max: 100` → `max: 10` (batas pooler Supabase free/pro jauh di bawah 100 per client).
- **Upload** `upload.route.ts`: tambahkan `limits: { fileSize: 5MB }` + `fileFilter` hanya image/*; ganti `fs.unlinkSync` dengan `fs.promises.unlink` di `finally` (sekarang file temp tertinggal kalau upload Cloudinary gagal).
- **`GET /order/:id` publik** (dipakai `bukti-transfer/[id]`): ID berurutan bisa di-enumerate. Tambah kolom `public_token uuid DEFAULT gen_random_uuid()`, link WA pakai token, endpoint publik baru `GET /order/public/:token` yang mengembalikan field minimal. *(Terkait auth tapi bisa dikerjakan terpisah.)*

---

## Fase 6 — Konsistensi akses DB

Sekarang campur supabase-js (anon key) dan `pg` Pool.
- Putuskan: backend **hanya** pakai `pg` (sudah ada `transaction`, `FOR UPDATE`). supabase-js cukup untuk auth nanti.
- Migrasi bertahap per service, mulai dari yang ada write multi-langkah: `order.service`, `stock.service` (lihat plan stock — `adjustStock` sekarang read-modify-write, rawan race), `dailyQuota.service`, `salary.service`.
- Setelah itu, aktifkan RLS di tabel sensitif Supabase supaya anon key di bundle frontend tidak bisa baca tabel langsung.

---

## Fase 7 — Test & kebersihan repo

- **Test:** tambah `vitest` + DB test (Postgres lokal via docker atau schema terpisah — **jangan** ke Supabase produksi) + mock Redis (`ioredis-mock` atau Upstash lokal). Prioritas kasus:
  1. `validateOrderItems` (unit).
  2. `createOrder`: kuota cukup / penuh / cold cache / 20 request paralel tidak overbook.
  3. Cancel & un-cancel mengembalikan kuota tepat.
- **Repo:**
  - Tambahkan `.DS_Store`, `.codegraph/`, `dist/` ke `.gitignore` masing-masing; `git rm --cached` untuk `rpn-frontend/tsconfig.tsbuildinfo` kalau ter-track.
  - `rpn-backend/README.md` (kosong) → isi cara setup, env yang dibutuhkan, `npm run migrate`.
  - Lengkapi `infra/render.yaml` `envVars` (sekarang cuma SUPABASE_*; kurang DATABASE_URL, UPSTASH_*, VAPID_*, CLOUDINARY_*, BITESHIP_*, FRONTEND_URL, CORS_ORIGINS).
- **Frontend:** pecah `app/orders/page.tsx` (1385 baris), `app/page.tsx` (1013), `app/pesan/page.tsx` (897). Kandidat pertama: komponen `FlavorPicker` — logika pilih rasa terduplikasi di `app/page.tsx:~772-830` dan `app/orders/page.tsx:~1200-1250`. Ini juga mempermudah Fitur 1 plan stock (kirim `variant_ids`).

---

## Ringkasan urutan

| Fase | Isi | Estimasi |
|---|---|---|
| 1 | Validasi qty/tanggal/phone | 0.5 hari |
| 2 | Bug kuota Redis (warming, cold cache, key legacy, updateOrder atomik) | 1–1.5 hari |
| 3 | Timezone WIB, harga & rekening dari DB | 1 hari |
| 4 | Refactor order route + idempotensi Biteship | 1 hari |
| 5 | Rate limit, error handler, pool, upload, public token | 1 hari |
| 6 | Seragamkan ke `pg` + RLS | 2–3 hari (bertahap) |
| 7 | Test + kebersihan repo + pecah halaman FE | berkelanjutan |

Fase 1–2 sebaiknya selesai **sebelum** Fitur 3 plan stock (auto potong stok), karena keduanya mengubah `createOrder`/`updateOrder`.

**Catatan hampers:** HAMPERS akan dihapus (Fase 0 [`plan-implementasi-stock-bahan-baku.md`](./plan-implementasi-stock-bahan-baku.md)). Kerjakan Fase 0 itu dulu, lalu Fase 2 di sini cukup menangani kuota box saja — semua referensi `hampers`/`quota:hampers:*`/`hourly:hampers:*` di atas otomatis gugur.
