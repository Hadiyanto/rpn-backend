# Fase 02: Bug kuota Redis

**Status:** ✅ kode selesai · ⏳ deploy + resync oleh user
**Tujuan:** sisa kuota di Redis selalu sama dengan `kuota DB − terpakai`, termasuk saat cache kosong (cold) atau setelah cancel/edit. HALF dihitung 0.5 box di semua tempat.

## Langkah kode
- [x] **Fondasi:** `src/utils/boxUnits.ts` berisi `BOX_UNITS_SQL`, `boxUnits()`, dan `remainingQuota()`. Ini satu-satunya definisi "FULL = 1, HALF = 0.5, tipe lain = 0", dipakai oleh daily sync, hourly sync, dan `createOrder`.
- [x] **2a:** `getUsedBoxByDate(store_id, dates[])` menghitung terpakai untuk banyak tanggal dalam 1 query. `getDailyQuotas` dan `getDailyQuotaByDate` memakai helper bersama `withRemaining()`. Saat cache kosong, sisa kuota = `qty − terpakai` dari DB, bukan qty penuh, lalu ditulis dengan SET NX + TTL.
- [x] **2a-bis:** `syncDailyRedisQuota` dan `syncHourlyRedisQuota` sekarang memakai `BOX_UNITS_SQL`, sehingga HALF = 0.5 (sebelumnya 1). Nilai dibaca dengan `parseFloat`, dan filter `o.pickup_date = ANY($2::date[])` menggantikan `to_char(...)` supaya index terpakai.
- [x] **2b:** `ensureDailyQuotaKey(store_id, date)` dipanggil `createOrder` sebelum decrement harian. Kalau tanggal tidak punya baris `daily_quota`, order ditolak 400 "Tanggal … belum dibuka untuk pemesanan". Warming kuota per jam di `createOrder` sekarang juga memakai TTL; sebelumnya tanpa TTL.
- [x] **2c:** blok restore legacy sudah dihapus di Fase 00 (dicek ulang).
- [x] **2e:** `upsertHourlyQuota` memanggil `syncHourlyRedisQuota` untuk semua tanggal `daily_quota` store itu yang ≥ hari ini (WIB). Key `hourly:base:*` yang tidak pernah dibaca dihapus.
- [x] **2d:** `updateOrder` sekarang satu transaksi `pg`: `SELECT … FOR UPDATE` → `UPDATE orders … RETURNING *` → `DELETE` + `INSERT order_items`. `updated_at` memakai `CURRENT_TIMESTAMP`.
- [x] **Tambahan:** `createDailyQuota` memanggil `syncDailyRedisQuota`, bukan menulis qty penuh. Ini penting kalau kuota tanggal dihapus lalu dibuat ulang padahal order sudah ada.
- [x] **Tambahan:** `config/db.ts` memakai `types.setTypeParser(DATE)`, sehingga kolom `date` dari `pg` dikembalikan sebagai string `YYYY-MM-DD`, sama dengan supabase-js. Ini sekaligus memperbaiki halaman sukses `/pesan` yang sebelumnya menampilkan `pickup_date` sebagai timestamp ISO (`2026-03-02T00:00:00.000Z`), dan menjaga bentuk response `updateOrder` versi `pg`.
- [x] `scripts/resync-quotas.ts`: sync ulang kuota harian dan per jam untuk semua tanggal ≥ hari ini.

## Verifikasi
- [x] `src/utils/__tests__/boxUnits.test.ts` (5 test). Total `npm test`: **38 test lulus**.
- [x] `tsc --noEmit` bersih, termasuk script.

## Deploy (user)
- [ ] Deploy backend.
- [ ] Jalankan `npx ts-node scripts/resync-quotas.ts` sekali, supaya nilai Redis yang salah karena bug HALF = 1 dan key "0" tanpa TTL terkoreksi.
- [ ] Cek `/config`: sisa kuota tanggal yang punya order HALF sekarang lebih besar (benar) dibanding sebelumnya.

## Catatan pengerjaan
- **Perubahan perilaku:** tanggal yang sebelumnya tampil "penuh" karena HALF dihitung 1 box bisa terbuka lagi setelah resync. Ini koreksi, bukan bug baru.
- Risiko yang tersisa (tidak diubah): `syncDaily/HourlyRedisQuota` memakai SET biasa. Kalau sync berjalan tepat saat ada order yang sudah reservasi di Redis tapi belum commit ke DB, reservasi itu bisa "terhapus" dan kuota bisa terlampaui sebanyak order tersebut. Peluangnya kecil; solusi yang lebih kuat adalah Lua script (lihat plan perbaikan 2b, opsional).
- Filter `day` di `getOrders` memakai operator `ov` pada kolom date, dan kelihatannya tidak berfungsi (hasilnya diselamatkan oleh filter in-memory). Tidak diubah di fase ini.
