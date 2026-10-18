# Rencana: Operasional pengiriman Biteship dan penutupan toko

## Tujuan

Membuat kegagalan pengiriman dan progres kurir terlihat oleh admin, memungkinkan admin mencoba ulang pengiriman dengan aman, serta mencegah toko ditutup saat masih ada order berbayar atau terkonfirmasi yang belum diselesaikan.

## Kondisi saat ini

- `orders.biteship_order_id` hanya menyimpan satu ID dari Biteship. `createBiteshipDispatch()` mengklaim kolom itu dengan nilai `PENDING`, membuat pengiriman, lalu menyimpan ID. Mekanisme ini mencegah duplikasi dasar, tetapi tidak menyimpan riwayat percobaan, kegagalan permanen, atau alasan yang bisa dilihat admin.
- `orderEvents.service.ts` saat ini membuat pesanan Biteship ketika order pengiriman toko berubah menjadi `DONE` (siap dikirim). Komentar di `order.route.ts` keliru menyebut dispatch terjadi saat `PAID`; perbarui komentar yang sudah tidak sesuai dan pertahankan pemicu `DONE` kecuali kebutuhan produk berubah.
- Halaman admin `/shipping` dapat membuat order Biteship dan meminta detail melalui `GET /biteship/order/:id`. Detail order menampilkan ID Biteship, tetapi belum ada panel status pelacakan/kurir maupun handler webhook.
- Data toko sudah memiliki `is_active`. Kolom itu dipakai untuk konfigurasi atau ketersediaan toko, bukan sebagai status yang jelas untuk menerima order. `open_time` hanya menyimpan informasi jam buka, bukan kontrol tutup manual.
- Push notification tersedia melalui `sendPushToAll()`. Belum terlihat middleware otorisasi admin di route backend yang ada. Endpoint mutasi baru harus memeriksa akses di backend, bukan hanya menyembunyikan tombol di frontend.

## Kriteria penerimaan dan rencana implementasi

### 1. Laporkan kegagalan alokasi Biteship

- Simpan setiap percobaan dispatch beserta siklus statusnya: ID order internal, ID order Biteship jika tersedia, nomor percobaan, kurir yang diminta, status (`PENDING`, `ALLOCATED`, `FAILED`, `CANCELLED`, `DELIVERED` sesuai kebutuhan), kode/pesan kegagalan, waktu kejadian, serta tautan pelacakan dan data kurir saat tersedia.
- Pertahankan riwayat percobaan saat admin mencoba ulang; jangan menimpa kegagalan sebelumnya. Gunakan tabel `order_deliveries` (atau tabel percobaan yang setara) yang terhubung ke `orders`, dengan indeks berdasarkan order dan status. Pertahankan `orders.biteship_order_id` sebagai penunjuk percobaan aktif/terbaru jika masih dipakai layar atau klien API yang ada.
- Catat kegagalan dari penolakan Biteship maupun validasi lokal atau konfigurasi toko yang tidak lengkap. Gunakan idempotensi provider jika didukung dan klaim percobaan secara atomik agar perubahan status paralel atau retry admin tidak membuat alokasi ganda.
- Tampilkan status gagal dan alasan singkat di detail order `/orders`, dengan tautan atau tindakan admin untuk mencoba ulang. Simpan detail terstruktur di log server, tetapi jangan tampilkan API key atau payload provider mentah ke browser.
- **Kriteria penerimaan:** kegagalan terlihat pada order RPN yang tepat, memuat alasan dan waktu yang berguna, tidak membuat pengiriman ganda saat status diubah berulang kali, dan tetap terlihat setelah halaman dimuat ulang atau server dimulai ulang.

### 2. Admin dapat melacak kurir yang ditugaskan

- Simpan data pelacakan yang dinormalisasi dari respons Biteship: tautan pelacakan, perusahaan/layanan kurir, nama dan nomor telepon driver jika tersedia, status provider, waktu sinkronisasi terakhir, serta estimasi tiba jika tersedia. Pastikan nama field respons aktual saat implementasi dan tangani field opsional yang kosong.
- Tambahkan bagian pelacakan pada detail order di `/orders` dan halaman admin `/shipping`. Tampilkan status terkini, kontak kurir/driver jika disediakan, tautan pelacakan, dan waktu pembaruan terakhir. Admin dapat meminta pembaruan manual melalui endpoint detail order Biteship yang sudah ada.
- Utamakan pembaruan melalui webhook/callback Biteship agar status cepat diketahui. Sebelum implementasi, verifikasi format event, mekanisme autentikasi/tanda tangan, perilaku retry, dan daftar status yang didukung dengan dokumentasi/API akun Biteship yang aktif. Jika webhook tidak tersedia, gunakan refresh manual admin dan polling terkontrol di server, bukan polling browser untuk setiap order.
- **Kriteria penerimaan:** admin dapat mengetahui kurir/driver yang ditugaskan dan membuka halaman pelacakan; pembaruan tetap berfungsi ketika field driver opsional tidak tersedia.

### 3. Admin dapat membuat ulang atau mencoba ulang pengiriman Biteship

- Tambahkan tindakan retry khusus admin untuk order `store_delivery` yang memenuhi syarat. Izinkan retry untuk percobaan yang gagal/belum dialokasikan dan percobaan yang dibatalkan provider. Minta konfirmasi eksplisit sebelum membuat pengiriman lain jika percobaan sebelumnya masih aktif atau hasilnya belum pasti.
- Buat catatan percobaan baru yang tidak mengubah riwayat setiap kali retry. Simpan percobaan dan ID provider sebelumnya. Pastikan hanya ada satu percobaan alokasi aktif per order melalui constraint/transaksi database atau perubahan status atomik.
- Gunakan kembali data asal, tujuan, item, pilihan kurir, dan snapshot biaya dari order. Jangan mengubah kurir atau biaya pelanggan tanpa pemberitahuan. Jika admin perlu memilih kurir lain, sediakan pilihan terpisah dan tampilkan selisih biaya sebelum dikirim.
- Jika Biteship menerima permintaan tetapi responsnya hilang, cocokkan dulu dengan ID/referensi provider sebelum retry agar tidak membuat pemesanan driver ganda.
- **Kriteria penerimaan:** retry menghasilkan satu percobaan baru, riwayat sebelumnya tetap tersimpan, pelacakan sukses mengarah ke percobaan terkini, dan klik bersamaan atau event status tidak membuat beberapa booking aktif.

### 4. Kirim notifikasi saat pengiriman Biteship tiba

- Petakan event Biteship yang sudah diverifikasi sebagai terkirim/tiba ke status pengiriman internal. Pastikan pemrosesan webhook terautentikasi, idempoten, dan aman terhadap callback duplikat atau yang datang tidak berurutan. Simpan ID event provider dan metadata audit minimum.
- Saat pertama kali status berubah menjadi terkirim, kirim push notification kepada admin berisi nomor order, toko, pelanggan, dan tautan ke detail order. Retry webhook tidak boleh mengirim notifikasi duplikat.
- Pisahkan status pengantaran kurir dari status pemenuhan order, kecuali bisnis memang menghendaki status order otomatis menjadi `DONE`. Jangan mengubah order menjadi `DONE` hanya berdasarkan callback provider yang belum diverifikasi atau tidak cocok dengan order.
- **Kriteria penerimaan:** event tiba yang terverifikasi memperbarui percobaan pengiriman yang tepat dan mengirim tepat satu notifikasi admin; event berulang tidak menghasilkan notifikasi tambahan.

### 5. Admin dapat menutup dan membuka kembali toko secara manual

- Tambahkan boolean khusus, misalnya `is_open_for_orders` atau `orders_enabled`, dengan nilai awal `true`, terpisah dari `is_active`. Tambahkan migrasi, field pada service/API toko, dan kontrol tutup/buka di pengaturan toko dengan status serta konfirmasi yang jelas.
- Terapkan status ini di backend saat pembuatan order dan pada endpoint opsi/ongkir store delivery; jangan hanya menyembunyikan kontrol di frontend. Order yang sudah ada dan pengeditan order oleh admin tetap dapat diakses. Tentukan apakah order terjadwal untuk waktu setelah toko tutup masih boleh dibuat. Asumsi awal rencana ini: toko yang ditutup tidak menerima order baru dari kanal mana pun.
- Pertahankan fungsi `is_active` agar penonaktifan operasional dan penutupan sementara penerimaan order tetap berbeda.
- **Kriteria penerimaan:** penutupan satu toko memblokir order baru pelanggan dan permintaan ongkir untuk toko tersebut saja; membuka kembali toko mengaktifkan penerimaan order; toko lain tidak terpengaruh.

### 6. Beri tahu admin jika toko ditutup saat masih ada order `PAID`/`CONFIRMED`

- Sebelum menutup toko, cari order toko itu yang masih berstatus `PAID` atau `CONFIRMED` (sesuai status yang disebut dalam AC). Tampilkan ID order, tanggal/jadwal, pelanggan, dan statusnya kepada admin.
- Perilaku aman yang diusulkan: tolak penutupan jika order tersebut masih ada, tampilkan daftarnya, dan kirim push alert admin bahwa toko belum dapat ditutup sampai setiap order diubah menjadi `DONE` atau `CANCELLED`. Ulangi pemeriksaan dalam transaksi penutupan agar perubahan antara pemuatan daftar dan penutupan tidak menimbulkan celah. Penutupan berhasil setelah semua order selesai.
- Jika kebutuhan bisnisnya adalah toko boleh langsung ditutup sambil memberi tahu admin tentang order yang belum selesai, ubah aturan agar penutupan tetap diizinkan dan buat alert yang persisten. Karena AC menyebut “semua order harus done / canceled”, asumsi awal rencana ini adalah penutupan diblokir.
- Tentukan apakah order `UNPAID` juga menghalangi penutupan. Interpretasi saat ini mengikuti AC secara harfiah: hanya `PAID`/`CONFIRMED` yang menghalangi; order `UNPAID` ditampilkan terpisah untuk diputuskan.
- **Kriteria penerimaan:** upaya menutup toko saat masih ada order `PAID`/`CONFIRMED` ditolak, menampilkan semua order penghalang, mengirim alert admin, dan membiarkan toko tetap buka. Setelah semua order penghalang berstatus `DONE` atau `CANCELLED`, penutupan berhasil. Pembuatan order dan penutupan yang terjadi bersamaan tidak boleh melewati pemeriksaan.

## Tahapan pengerjaan yang disarankan

1. **Fondasi:** pastikan pemicu dispatch tetap `DONE` atau perlu diubah, pemetaan status, aturan penutupan, dan model otorisasi admin. Tambahkan skema percobaan pengiriman dan status khusus penerimaan order toko.
2. **Siklus backend:** ubah dispatch Biteship agar memakai catatan percobaan; tambahkan retry admin yang aman, pengambilan/normalisasi status, endpoint webhook terverifikasi jika didukung, serta endpoint tutup/buka toko dengan pemeriksaan order belum selesai dalam transaksi.
3. **Antarmuka admin:** tambahkan kegagalan/riwayat/pelacakan/tindakan retry ke `/orders` dan `/shipping`; tambahkan kontrol buka/tutup toko serta daftar order penghalang di pengaturan toko.
4. **Notifikasi dan ketahanan:** tambahkan notifikasi terkirim yang idempoten dan alert saat penutupan terhalang; lengkapi log audit; tangani timeout provider, respons yang hasilnya belum pasti, callback duplikat, data driver yang kosong, dan retry bersamaan.
5. **Rilis:** terapkan migrasi database sebelum backend; rilis backend sebelum frontend; verifikasi konfigurasi webhook dan secret Biteship; uji dengan kredensial sandbox/test dan satu pengiriman live yang terkontrol sebelum mengaktifkan retry admin secara luas.

## File utama yang akan diubah

- Backend: `src/services/biteship.service.ts`, `src/services/orderEvents.service.ts`, `src/routes/biteship.route.ts`, `src/routes/order.route.ts`, `src/services/order.service.ts`, `src/services/store.service.ts`, `src/routes/store.route.ts`, `src/services/push.service.ts`, serta file migrasi dan pengujian unit/integrasi terkait.
- Frontend: `rpn-frontend/app/orders/page.tsx`, `rpn-frontend/app/shipping/page.tsx`, `rpn-frontend/components/config/StoreSettings.tsx`, serta tipe data API toko/order.

## Keputusan yang perlu dipastikan

1. Pertahankan booking Biteship otomatis saat status `DONE` (perilaku saat ini ketika order siap dikirim), atau pindahkan ke `PAID`? Komentar route sudah usang dan bukan gambaran perilaku aktual.
2. Apakah pelacakan driver hanya perlu menampilkan tautan/status Biteship, atau juga nama dan nomor telepon driver jika Biteship menyediakannya?
3. Apakah toko yang ditutup menolak semua order baru termasuk order terjadwal, atau hanya order yang waktu pemenuhannya jatuh selama periode tutup?
4. Apakah order `UNPAID` juga menghalangi penutupan? Rencana ini mengikuti AC dan hanya memblokir `PAID`/`CONFIRMED`.
5. Pastikan dukungan webhook dan kredensial pada akun Biteship aktif. Jika tidak tersedia, gunakan refresh admin dan polling terkontrol.

## Perubahan lanjutan (2026-10-18, belum di-commit)

- **Tutup toko + order UNPAID** (`services/storeClosure.service.ts`, `POST /stores/:id/close-orders`):
  PAID/CONFIRMED tetap memblokir (409 `STORE_HAS_OPEN_ORDERS` + push). Order UNPAID tidak memblokir, tapi
  backend menjawab 409 `STORE_HAS_UNPAID_ORDERS` dengan pesan "Order #12, #13 masih UNPAID. Tutup toko akan
  mengubah status order tersebut menjadi CANCELLED." Setelah admin setuju, FE mengirim `cancel_unpaid_ids`
  (harus sama persis dengan daftar UNPAID saat itu; kalau ada order UNPAID baru → ditanya ulang). Toko
  ditutup, order tersebut di-CANCELLED lewat `changeOrderStatus` (kuota & bahan baku kembali), dan admin
  dapat push "🔒 <toko> ditutup · Order UNPAID … dibatalkan".
- `changeOrderStatus(id, status, { expectedStatus })`: hanya mengubah order yang masih di status itu.
  Dipakai saat tutup toko dan oleh DOKU (SUCCESS/EXPIRED), jadi pembayaran yang masuk tidak tertimpa
  cancel dan order yang sudah dibatalkan tidak berubah jadi PAID.
- **Push gagal alokasi** (`notifyDeliveryProblem`, migration `1792270000000` kolom `failure_notified_at`):
  sekali per percobaan untuk FAILED, CANCELLED oleh Biteship, atau hasil booking belum pasti; dari
  dispatch otomatis/retry, webhook, maupun tombol Perbarui.
- **Push sampai** (`notifyDeliveryDelivered`): judul "✅ Order #123 sudah sampai", isi pelanggan, toko,
  kurir + driver/plat, jam tiba WIB; sekali per percobaan.
- Push membawa `url` `/orders?order=<id>` (halaman `/orders` membuka order itu) dan `tag` per order;
  dikirim dengan `urgency: high`.
- **Service worker**: `next.config.js` `customWorkerSrc` menunjuk ke file (`sw-push.js`) sehingga
  next-pwa tidak pernah mem-bundle handler push. Sekarang `worker/index.js` (notifikasi tetap tampil
  sampai disentuh, `renotify`, getar panjang, klik membuka order). `public/sw-push.js` dihapus; rewrite
  dan path publik ditambah `worker-*.js`.
- **Suara di halaman `/orders`**: `utils/alertSound.ts` (chime keras 2×, + getar) untuk order baru dan
  order PAID hari ini; audio di-unlock pada sentuhan pertama.
- Test: `src/services/__tests__/storeCloseAndDeliveryNotify.integration.test.ts` (6 test).
