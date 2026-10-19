# Plan: Paxel (Small) untuk pelanggan whitelist, tujuan luar Jabodetabek

Status: **diimplementasi (belum di-commit)** · dibuat 2026-10-19 · `test:db` 242/242 lulus · uji lokal
sandbox: order #384 ke Bandung → Paxel Small 21.500, booking `confirmed` (item tanpa dimensi; Biteship
mencatatnya 1×1×1 cm)

## Tujuan

Store Delivery menawarkan **Paxel layanan `small`** sebagai pilihan kurir tambahan, dengan dua syarat:
1. nomor WhatsApp pelanggan ada di **whitelist**, dan
2. alamat tujuan **di luar Jabodetabek**.

Selain itu Paxel diperlakukan sama seperti kurir lain (ditawarkan sepanjang hari, booking `now` saat order
DONE). Pelanggan lain dan tujuan di Jabodetabek tetap melihat kurir seperti sekarang (grab instant,
gojek instant, lalamove motorcycle). Untuk sementara **tanpa logika dimensi**: selalu Paxel `small`.

## Keputusan (dari user, 2026-10-19)

| # | Pertanyaan | Keputusan |
|---|---|---|
| 1 | Whitelist kosong | **Tidak ada yang dapat Paxel.** |
| 2 | Jam / cut-off | **Sama seperti kurir lain** (tidak disembunyikan per jam), **hanya untuk tujuan di luar Jabodetabek**. |
| 3 | `/shipping` (booking manual admin) | **Di-skip dulu**, tidak diubah. |
| – | Dimensi box asli | FULL **20×10×5 cm**, HALF **10×10×5 cm** (lihat catatan data di bawah). |

## Hasil cek Biteship (sandbox, 2026-10-19)

Dicek dengan key `biteship_test.` (read-only: `GET /v1/couriers` dan `POST /v1/rates/couriers`, tanpa
membuat order). Origin RPN Kalibata.

**Layanan Paxel** (`GET /v1/couriers`): `small`, `medium`, `large` (same_day, parcel, 8–12 jam) dan
`paxel_big` (freight). Semua `available_collection_method = ["pickup"]`, tanpa COD.

**Kapan `small` ditawarkan** (tujuan Pancoran):

| Item | Dimensi dikirim | Hasil |
|---|---|---|
| 1 FULL | asli 20×10×5 | small 15.500 · medium · large |
| 2 / 3 / 4 FULL | asli | medium · large — **tanpa small** |
| 1 / 2 HALF | asli 10×10×5 | small · medium · large |
| 4 HALF | asli | tanpa small |
| 1 FULL + 1 HALF | asli | small · medium · large |
| FULL qty 1–4 (≤ 2,4 kg) | **tanpa dimensi** (berat saja) | small · medium · large |
| FULL qty 10 (6 kg) | tanpa dimensi | hanya paxel_big |
| 1 item 500 g – 5 kg | 10×10×10 | small (berat tidak memengaruhi) |

Kesimpulan: dengan dimensi asli, `small` hanya untuk ±1 Box Besar (atau setara). Karena diminta **tanpa
logika dimensi**, item Paxel dikirim **tanpa `length/width/height`** (opsional di Biteship; `weight`
wajib) → `small` tersedia sampai ±5 kg total (±8 Box Besar). Di atas itu Paxel tidak ditawarkan.

**Wilayah tujuan dari respons rates** (`destination.administrative_division_level_*_name`):

| Titik | L1 (provinsi) | L2 (kota/kab) | Paxel small | Kurir instant tersedia |
|---|---|---|---|---|
| Pancoran | DKI Jakarta | Jakarta Selatan | 15.500 | grab, gojek, lalamove |
| Depok (Margonda) | Jawa Barat | Depok | 18.000 | grab, gojek, lalamove |
| Kota Bogor | Jawa Barat | Bogor | 18.000 | gojek, lalamove |
| Cibinong (Kab. Bogor) | Jawa Barat | Bogor | 18.000 | gojek, lalamove |
| Kota Bekasi | Jawa Barat | Bekasi | 18.000 | grab, gojek, lalamove |
| Cikarang (Kab. Bekasi) | Jawa Barat | Bekasi | 18.000 | gojek, lalamove |
| Kota Tangerang | Banten | Tangerang | 18.000 | gojek, lalamove |
| BSD / Cisauk | Banten | Tangerang | 18.000 | gojek, lalamove |
| **Bandung** | Jawa Barat | Bandung | **21.500** | — (hanya Paxel) |
| **Karawang** | Jawa Barat | Karawang | **tidak ada Paxel** | gojek, lalamove |

Biteship memakai nama L2 pendek dan tidak membedakan kota/kabupaten ("Bogor", "Bekasi", "Tangerang").
Jadi **Jabodetabek** = `L1 = "DKI Jakarta"` **atau** `L2 ∈ {Bogor, Depok, Tangerang, Tangerang Selatan,
Bekasi}`. Di luar itu = boleh Paxel (kalau Biteship menawarkannya; Karawang di sandbox tidak).

Dokumentasi Biteship ([Create Order](https://biteship.com/en/docs/api/orders/create),
[Error Codes](https://biteship.com/en/docs/api/orders/error)): dimensi item opsional; `delivery_type`
`now`/`scheduled`; error relevan `40002007` (tidak mendukung scheduled), `40002037` (batas jam order
same-day). Jam cut-off Paxel belum diketahui (artikel help center Biteship 403).

## Desain

1. **Whitelist:** env `PAXEL_WHITELIST` (nomor WA dipisah koma, format bebas, dinormalisasi
   `formatWAPhone`). Kosong = tidak ada yang dapat Paxel.
2. **Wilayah:** `isOutsideJabodetabek(destination)` dari objek `destination` di respons rates Paxel
   (L1/L2 seperti tabel di atas). Kalau `destination` tidak ada di respons → anggap Jabodetabek (Paxel
   tidak ditawarkan, aman).
3. **Hanya `paxel/small`;** `medium`, `large`, `paxel_big` dibuang. Tidak ada fallback.
4. **Tanpa dimensi untuk Paxel** di cek ongkir dan booking (item: `name`, `description`, `value`,
   `weight`, `quantity`). Kurir lain tetap memakai dimensi dari tabel `menu`.
5. **Dua panggilan rates** hanya untuk nomor whitelist: panggilan sekarang (kurir instant, dengan
   dimensi) + `couriers=paxel` tanpa dimensi, paralel, lalu digabung dan diurutkan dari termurah.
   Nomor non-whitelist: satu panggilan seperti sekarang. Kalau panggilan Paxel gagal, opsi instant tetap
   ditampilkan (Paxel diabaikan + log). Sebaliknya, kalau panggilan instant ditolak Biteship ("No courier
   available for requested location", mis. ke Bandung) tetapi Paxel Small ada, **Paxel saja** yang
   ditampilkan; tanpa Paxel, error lama tetap muncul (ditemukan saat uji lokal 2026-10-19).
6. **Paxel tidak ikut `SELECTED_COURIER`** (itu tetap untuk kurir instant).
7. **Booking `delivery_type: now`** saat DONE, sama seperti kurir lain; tidak ada aturan jam.
8. `POST /order` tetap menghitung ulang ongkir di server, jadi Paxel dari nomor non-whitelist atau tujuan
   Jabodetabek otomatis ditolak (409 "Kurir yang dipilih sedang tidak tersedia").

## Rencana implementasi

### Backend (`rpn-backend`)

1. `src/utils/deliveryArea.ts` (baru, pure): `JABODETABEK_L2`, `isOutsideJabodetabek(destination)`.
2. `src/services/biteship.service.ts`
   - `paxelWhitelist()`, `isPaxelAllowed(phone)`; konstanta `PAXEL_SERVICE = 'small'`.
   - `paxelShippingItems(items)`: item tanpa `length/width/height`.
   - `getStoreDeliveryOptions({ ..., customer_phone })`: bila `isPaxelAllowed`, panggil rates
     `couriers: 'paxel'` tanpa dimensi; ambil `paxel/small` hanya bila
     `isOutsideJabodetabek(data.destination)`; gabung dengan opsi instant.
   - `createBiteshipDispatch`: bila `delivery_courier_company === 'paxel'`, item tanpa dimensi.
3. `src/services/order.service.ts`: `deliveryOptionsFor` / `resolveStoreDelivery` /
   `storeDeliveryOptionsForOrder` meneruskan `customer_phone`.
4. `src/routes/biteship.route.ts`: komentar `store-delivery-options` (opsi bergantung nomor WA + wilayah).
5. `.env.example`: `PAXEL_WHITELIST`.

Tanpa migration (`delivery_courier_company = 'paxel'`, `delivery_courier_type = 'small'` di kolom yang
ada). Retry, refresh, poller, webhook tidak berubah; status Paxel sudah tercakup `normalizeDeliveryStatus`.
`/shipping` tidak diubah (keputusan 3).

### Frontend (`rpn-frontend`)

1. `app/pesan/page.tsx`: tambahkan `form.customer_phone` ke efek yang mereset `courierOptions` /
   `selectedCourier` (whitelist bergantung nomor).
2. Kartu kurir sudah generik (`courier_name`, `service_name`, `duration`, `price`) → Paxel Small tampil
   otomatis. Opsional: catatan "Same day, 8–12 jam" bila `courier_company === 'paxel'`.

### Data (bukan kode, dijalankan admin)

Dimensi box di tabel `menu` saat ini **FULL 20×20×10, HALF 10×10×10** — tidak sesuai box asli
(**20×10×5** / **10×10×5**). Perbaiki di `/config` → kartu menu (atau beri tahu saya untuk menyiapkan
SQL-nya; perubahan DB produksi tetap dijalankan setelah konfirmasi). Ini memengaruhi ongkir kurir instant
dan `/shipping`, bukan Paxel (Paxel dikirim tanpa dimensi).

### Test

- Unit: `isPaxelAllowed` (08… / 628… / +62…, whitelist kosong = false); `isOutsideJabodetabek` (DKI,
  Depok, Bogor, Bekasi, Tangerang, Tangerang Selatan = false; Bandung, Karawang, Semarang = true;
  `destination` kosong = false); filter layanan (hanya small).
- Integration (Postgres lokal, `biteshipPost` di-mock dengan respons sandbox di atas): whitelist + Bandung
  → Paxel Small + opsi lain; whitelist + Depok → tanpa Paxel; non-whitelist + Bandung → tanpa Paxel;
  panggilan Paxel gagal → opsi instant tetap; `createOrder` Paxel dari non-whitelist → 409; payload dispatch
  Paxel tanpa dimensi.
- Manual di lokal (`run-local.sh`, key sandbox): order Paxel ke Bandung → PAID → DONE → attempt + tracking
  di `/orders`.

### Deploy

1. Isi `PAXEL_WHITELIST` di `setupvps/env-plain/rpn/rpn-backend/.env` → `./env-encrypt.sh rpn` → push.
2. Deploy backend lalu frontend (tanpa migration).
3. Uji 1 order Paxel sungguhan (live key) ke luar Jabodetabek dari nomor whitelist.

Perkiraan: backend ±2,5 jam (termasuk test), frontend ±15 menit, uji sandbox ±30 menit.

## Risiko

- **Ukuran fisik diabaikan** untuk Paxel: >1 Box Besar sebenarnya melebihi `small` (lihat tabel). Kurir
  bisa menolak saat pickup atau Biteship menagih selisih. Diterima sementara; jalan keluar nanti:
  kirim dimensi asli dan pilih small/medium sesuai hasil rates.
- **Cut-off pickup Paxel belum diketahui.** Order DONE sore/malam bisa dijemput besok atau gagal
  (`40002037`); kegagalan sudah tercatat FAILED + push admin + tombol Coba ulang.
- **Batas ±5 kg** (sandbox): order besar tidak mendapat Paxel.
- **Klasifikasi wilayah bergantung nama dari Biteship.** Kalau Biteship mengubah penamaan L2 (mis.
  "Kota Bekasi"), Paxel bisa ikut tampil di Jabodetabek. Mitigasi: cocokkan dengan `includes`
  (case-insensitive) dan test dengan respons produksi saat uji live.
- **Whitelist bukan autentikasi:** siapa pun yang mengetik nomor whitelist melihat Paxel. Dampak kecil
  (hanya pilihan kurir).
