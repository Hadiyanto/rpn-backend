# Plan: Storefront, alur order baru, WA per store, CMS storefront, auth sendiri

Status: **rencana — keputusan sudah diambil** · diperbarui 2026-10-10

Lanjutan dari [`plan-lepas-vendor.md`](plan-lepas-vendor.md) (Fase 2 = auth, Fase 4 = lepas Supabase).

## Keputusan

| # | Keputusan |
|---|---|
| Rute | `/` = storefront · `/pesan` = form order customer · `/orders` tetap halaman admin daftar pesanan |
| K1 | Halaman status pesanan di **`/status/[token]`** (pengganti `/bukti-transfer`) |
| K2 | Storefront punya **section & gambar sendiri**, dikelola lewat **mini CMS** di Config: admin menambah, mengganti nama/teks, mengurutkan, (non)aktifkan section, dan mengisi foto |
| K2a | **Tipe section** dipilih per section; v1: **banner, grid galeri, teks** (carousel menyusul) |
| K2b | **Satu storefront untuk semua store** |
| K2c | Urutan: tombol **naik/turun** (drag & drop menyusul) · Teks: **teks biasa** dengan baris baru (tanpa rich text — beban & risiko XSS) |
| K3 | Kolom baru **"Link Google Maps"** per store (Config → Store); dipakai di WA & storefront, kosong → link dari koordinat |
| K4 | Storefront = **galeri/display**, belum terhubung ke item di keranjang |
| K5 | Auth sendiri dengan role **superadmin, owner, employee** + **RBAC** per halaman (publik vs terbatas) |
| Desain | Storefront & **semua font aplikasi** bergaya **levainbakery.com** (lihat §Desain) |
| WA | Alamat, Maps, rekening di pesan WA **dari data store** order itu |
| Logout | → `/` |
| Rilis | **Rilis 1** dideploy (alur order + storefront berdesain, konten tetap). **CMS + auth** dikerjakan & diuji **di lokal saja**, tanpa commit, lalu **satu kali deploy**; **Supabase dilepas** sesudahnya |

## Kondisi sekarang (dicek di kode)

| Hal | Sekarang |
|---|---|
| `/` | form order customer (`app/page.tsx`) |
| `/pesan` | redirect ke `/` (`next.config.js`) |
| `/orders` | halaman admin daftar pesanan (tujuan setelah login) |
| `/bukti-transfer/[id]` | status order DOKU + upload bukti; link WA & tujuan kembali dari DOKU; masih menerima id angka |
| Halaman publik (middleware) | `/`, `/login`, `/bukti-transfer/*`, `/demo` (folder `demo` tidak ada); aset PWA ikut di-redirect ke login |
| Logout | `router.push('/')` → form order |
| WA order baru | rekening **BCA 1280119748 a.n. Anggita Prima** hardcode untuk semua store & metode bayar (kecuali DOKU) |
| WA PAID (pickup) | alamat **Kalibata** + link Maps hardcode, juga untuk Depok |
| `stores` | `name, address, latitude, longitude, phone, open_time, last_pickup_time, bank_name, bank_account_number, bank_account_name, qris_image_url` (belum ada link Maps) |
| Font | satu font: **Public Sans** (`app/layout.tsx`, `--font-display` / `--font-sans`) |
| Login | Supabase Auth; **API backend tidak memeriksa login** |

## Rute target

| Rute | Isi | Akses |
|---|---|---|
| `/` | storefront (lihat §Desain) | publik |
| `/pesan` (`?store=<id>`) | form order; `?store` memilih store otomatis dan langsung ke menu | publik |
| `/status/[token]` | ringkasan + status. DOKU: bayar sekarang / berhasil / kedaluwarsa · TRANSFER: rekening store + upload bukti · QRIS manual: QRIS store + upload · CASH: info pickup/pengiriman | publik (token) |
| `/bukti-transfer/[token]` | redirect → `/status/[token]` (link WA lama); id angka tidak dilayani lagi | publik |
| `/login`, `/orders`, … | admin | login (RBAC di Rilis 2) |

## Desain storefront (referensi: levainbakery.com)

**Susunan halaman `/`** (Rilis 1: konten tetap di kode + data yang ada; Rilis 2: section dari CMS):

1. **Header** — logo/brand, link "Pesan", "Lokasi"; sticky, latar krem.
2. **Banner (hero)** — gambar penuh lebar, judul besar, subjudul, tombol "Pesan sekarang" → `/pesan`.
3. **Baris keunggulan** — 3–4 poin pendek (mis. "Digoreng saat dipesan", "Ambil di toko / dikirim", …).
4. **Favorit** — grid rasa terlaris (foto rasa + nama + harga mulai; dari `/api/variants` + best-sellers).
5. **Cerita** — gambar + teks tentang brand.
6. **Lokasi** — kartu per store: nama, alamat, jam buka – pickup terakhir, tombol **Google Maps**
   (`maps_url`) dan "Pesan di store ini" → `/pesan?store=<id>`.
7. **Footer** — kontak (WA/IG), alamat store, © brand.

**Gaya:** latar krem/off-white, teks hampir hitam, satu warna aksen brand (kuning/merah marun yang
sudah dipakai), whitespace lega, foto besar penuh lebar, kartu dengan sudut membulat & bayangan
tipis, label kecil huruf kapital dengan letter-spacing, tombol solid membulat. Mobile first.

**Font** (seluruh aplikasi, termasuk admin). Levain memakai font berbayar (Platform, Pitch,
National 2 — tidak boleh disalin); padanan gratis dari Google Fonts lewat `next/font`:

| Peran | Levain | Pengganti (usulan) |
|---|---|---|
| Judul (heading) | Platform | **Archivo** (grotesk tebal, lebar) |
| Label, badge, harga kecil | Pitch (mono) | **Space Mono** |
| Teks | National 2 / Assistant | **Assistant** (font teks yang memang dipakai Levain) |

`app/layout.tsx` memuat ketiganya; `globals.css`: `--font-sans` = Assistant, `--font-display` = Archivo,
`--font-mono` = Space Mono. Halaman admin ikut berganti font (teks Assistant, judul Archivo) — cek
tabel & angka tetap terbaca.

## CMS storefront (Rilis 2)

**Data**
- `storefront_sections`: `id, type ('banner'|'gallery'|'text'), title, subtitle, body (teks biasa),
  cta_label, cta_href, sort_order, is_active, created_at, updated_at`.
- `storefront_images`: `id, section_id, image_url (Cloudinary), caption, alt, sort_order`.
- Section bawaan berbasis data (**Favorit**, **Lokasi**) tetap dirender dari data menu/store; posisinya
  bisa ikut diurutkan (tipe `favorites`, `locations`, tanpa foto).

**Backend**: CRUD section & foto, `PATCH …/move` (naik/turun), validasi per tipe (banner: 1 foto +
judul; gallery: ≥1 foto; text: body wajib), endpoint publik `GET /api/storefront` (cache Redis seperti
menu, dibuang saat ada perubahan), upload lewat `/upload-image`. Endpoint admin **wajib login**
(owner/superadmin).

**Admin (Config → Storefront)**: daftar section (tipe, judul, aktif, ▲▼), tambah section (pilih tipe),
form judul/subjudul/teks/CTA, kelola foto (upload beberapa, caption, ▲▼, hapus), tombol "Lihat
storefront".

**Storefront**: komponen per tipe (`Banner`, `Gallery`, `TextBlock`, `Favorites`, `Locations`), render
di server dari `GET /api/storefront`; gambar lewat transformasi Cloudinary (ukuran sesuai layar).

## Auth sendiri + RBAC (Rilis 2)

Detail teknis login/sesi: `plan-lepas-vendor.md` §4. Tambahan:

- **Role**: `superadmin`, `owner`, `employee` (kolom `users.role`).
- **RBAC per halaman**: tabel/konstanta izin role → halaman (mis. `orders`, `sales`, `stock`,
  `finance`, `cashflow`, `config`, `summary`, `salary`, `shipping`, `storefront`, `users`), dipakai
  di frontend (menu/halaman) **dan** backend (`requirePage`). Usulan awal (dibahas lagi):
  superadmin = semua + kelola user · owner = semua kecuali kelola user superadmin · employee =
  orders, stock (lainnya ditentukan nanti).
- Halaman publik tanpa login: `/`, `/pesan`, `/status/*`, `/bukti-transfer/*`, `/login` + endpoint
  publik (plan-lepas-vendor §4.2, ditambah `GET /api/storefront`).
- Kelola user: script dulu (`scripts/user.ts`), halaman "Pengguna" (superadmin) menyusul.

## Task list

### Rilis 1 — dideploy (commit ke branch kerja)

| ID | Task | Repo | Perkiraan |
|---|---|---|---|
| A1 | Form order ke `/pesan` (+ `?store`), hapus redirect `/pesan`, middleware publik (+ aset PWA, hapus `/demo`) | FE | 0,5 h |
| A2 | Font baru (Archivo / Assistant / Space Mono) di `layout.tsx` + `globals.css`, cek halaman admin | FE | 0,5 h |
| A3 | Storefront `/` berdesain (header, banner, keunggulan, favorit, cerita, lokasi, footer); konten tetap di kode + data menu/store | FE | 1,5–2 h |
| A4 | `/status/[token]` per metode bayar + redirect `/bukti-transfer/*`; tolak id angka | FE | 1 h |
| A5 | Logout → `/`; tombol kembali expenses → `/orders`; sukses order → `/status/[token]` | FE | 0,25 h |
| B1 | Link WA & DOKU (`callback_url`) → `/status/<token>` | BE | 0,25 h |
| B2 | Migration `stores.maps_url` + field "Link Google Maps" di Config → Store | BE+FE | 0,5 h |
| B3 | WA per store & per metode bayar (alamat, Maps, rekening, QRIS), `BRAND_NAME` env, test | BE | 1 h |

Rilis bersamaan FE + BE (link WA/DOKU berpindah ke `/status/<token>`). Migration B2 dijalankan saat deploy.

### Rilis 2 — lokal saja, tanpa commit, lalu satu kali deploy

| ID | Task | Repo | Perkiraan |
|---|---|---|---|
| C1 | Migration `users` + `sessions` (role superadmin/owner/employee), salin `user_roles` | BE | 0,5 h |
| C2 | Endpoint auth, `requireAuth`, RBAC `requirePage`, `AUTH_MODE`, script user, test | BE | 1,5–2 h |
| C3 | Login/me/logout di FE, menu & halaman per role, `credentials: 'include'`, middleware cookie | FE | 1–1,5 h |
| E1 | Migration `storefront_sections` + `storefront_images`, CRUD + move + publik + cache, test | BE | 1–1,5 h |
| E2 | Config → Storefront (section, tipe, teks, foto, ▲▼, aktif) | FE | 2 h |
| E3 | Storefront `/` dari CMS (komponen per tipe; isi Rilis 1 jadi section awal lewat seed) | FE | 1 h |
| C4 | Deploy sekali: migration → buat user → `AUTH_MODE=log` → cek → `enforce` | ops | 0,5 h |

**Cara kerja tanpa commit**: dikerjakan di working tree lokal (atau branch lokal yang tidak di-push,
supaya ada titik simpan); diuji dengan DB salinan lokal + Redis lokal (`scratchpad/local-env.sh`).
Saat siap: commit + push sekali, deploy, migration.

#### Status C1–C3 (2026-10-17, lokal, belum di-commit)

Keputusan: **reset password** (bukan impor hash Supabase), **sesi di DB** (bukan JWT), **cek Origin** untuk CSRF.

- **C1** `migrations/1792260000000_users-and-sessions.js`: tabel `users` (role `superadmin|owner|employee`,
  email lowercase) + `sessions` (`token_hash` sha256). Isi `user_roles` disalin dengan id sama
  (`admin` → `superadmin`, lainnya → `employee`) dengan `password_hash = '!'`, jadi **belum bisa login
  sampai password di-reset**. `user_roles` belum dihapus (D1). Up/down sudah dicoba di DB test lokal.
- **C2** backend:
  - `src/config/auth.ts` (AUTH_MODE, cookie, daftar halaman), `src/utils/password.ts` (scrypt),
    `src/services/auth.service.ts`, `src/routes/auth.route.ts` (`POST /auth/login|logout`, `GET /auth/me`,
    rate limit 5×/15 menit per IP+email), `src/cli/user.ts`.
  - `src/middleware/auth.ts` dipasang di `routes/index.ts` untuk semua `/api`: `csrfGuard` (write yang
    membawa cookie sesi wajib `Origin`/`Referer` ∈ `CORS_ORIGINS`) → `loadSession` (cookie basi
    dihapus; masa berlaku digeser maks. 1×/jam) → `authorize` (`PUBLIC_ROUTES` + `PAGE_RULES`).
  - `requireAdmin` sekarang berbasis sesi (superadmin/owner atau halaman `config`), tetap aktif di
    semua AUTH_MODE seperti sebelumnya.
  - Superadmin/owner melihat semua halaman (termasuk `analytics` & `shipping` yang dulu tidak ada di
    `allowed_pages` admin); employee sesuai `allowed_pages`.
  - Test: `src/middleware/__tests__/auth.test.ts` (unit) dan `src/routes/__tests__/auth.integration.test.ts`
    (HTTP sungguhan + Postgres lokal). `npm test` 132 lulus, `npm run test:db` 208 lulus.
- **C3** frontend: `utils/fetchJson.ts` → `apiFetch` (`credentials: 'include'` untuk `API_URL`, 401 di
  halaman admin → `/login`); `adminFetchJson`, push, WhatsApp, kirim WA di `/orders` ikut `apiFetch`;
  login/logout/`useUserRole` ke `/api/auth/*`; `middleware.ts` hanya cek ada cookie `rpn_session`
  (tanpa panggilan Supabase per request); daftar halaman publik di `utils/publicPaths.ts`.
  `utils/supabase/*`, `app/auth/callback` dan dependency `@supabase/*` dibiarkan untuk D1.
- **Uji lokal** (`run-local.sh`, sekarang set `AUTH_COOKIE_SECURE=false` + `CORS_ORIGINS`): login salah →
  pesan error; login owner → `/orders`, `/config`, WhatsApp status OK; kasir (employee, `orders`) → API
  gaji 403 dan halaman `/salary` dialihkan ke `/orders`; logout dan user dinonaktifkan → kembali ke
  `/login` tanpa loop; `/`, `/pesan`, `/status/*` tetap terbuka tanpa login.
- **Belum**: `npm run build` frontend (dev server lokal sedang jalan), field `GET /stores` untuk publik
  belum dipangkas, halaman "Pengguna" (pakai CLI dulu).

#### C4 — langkah deploy (dijalankan user)
1. Env backend: `AUTH_MODE=log`, `AUTH_COOKIE_DOMAIN=.rajapisangnugget.com`, `CORS_ORIGINS` berisi
   persis `https://rajapisangnugget.com` (juga daftar CSRF).
2. `docker exec rpn-backend npm run migrate up`, lalu deploy BE + FE.
3. Password per admin: `docker exec -it rpn-backend node dist/cli/user.js reset-password <email>`
   (dicetak sekali, kirim langsung ke orangnya). `list` untuk cek, `access <email> <role> [pages]` untuk ubah.
4. Pakai semua halaman admin, lalu cek log `docker logs rpn-backend | grep "\[auth\] would"`: harus kosong
   untuk user yang berhak. Rule halaman ada di `PAGE_RULES` (`src/middleware/auth.ts`).
5. `AUTH_MODE=enforce` (atau hapus variabelnya, default enforce) → restart backend.
6. Catatan IP: di repo setupvps (belum di-commit) site RPN sekarang meng-include
   `nginx/snippets/cloudflare-real-ip.conf` (`real_ip_header CF-Connecting-IP` hanya dari range
   Cloudflare), jadi `req.ip` = IP pengunjung, bukan IP edge Cloudflare. Deploy: `git pull && ./04-nginx.sh rpn`
   di VPS; cara cek ada di README setupvps ("Real visitor IP behind Cloudflare"). Tanpa ini limiter
   global & `POST /order` (5/15 menit) dibagi semua pelanggan per edge.

### Rilis 3 — lepas Supabase (setelah Rilis 2 stabil ±1 minggu)

| ID | Task | Repo | Perkiraan |
|---|---|---|---|
| D1 | Hapus `@supabase/*`, `utils/supabase`, `auth/callback`, `config/supabase.ts`, script lama, opsi restore Supabase di `tools/db-backup`; hapus env `*SUPABASE*` (`env-plain` → encrypt); drop `user_roles`; pause project Supabase | FE+BE+setupvps | 0,5 h |

**Total perkiraan**: Rilis 1 ≈ 5–6 h · Rilis 2 ≈ 8–9 h · Rilis 3 ≈ 0,5 h.

## Uji

- **Rilis 1**: `/` di HP & desktop (Safari/Chrome), font baru di storefront & admin; pilih store →
  `/pesan?store` langsung ke menu; order TRANSFER (WA berisi rekening store yang benar + link
  `/status/<token>`, upload bukti jalan); order DOKU (kembali ke `/status/<token>`, PAID); order Depok →
  WA PAID beralamat & Maps Depok; link lama `/bukti-transfer/<token>` redirect; logout → `/`.
- **Rilis 2**: login per role, menu & halaman sesuai RBAC, `curl` API admin tanpa cookie → 401,
  storefront + `/pesan` + `/status/*` tanpa login; CMS: tambah/ubah/urutkan/nonaktifkan section,
  upload/urutkan foto, hasil tampil di `/` (cache terbuang); employee tidak bisa membuka Config.
- **Rilis 3**: build tanpa paket Supabase, login tetap jalan.

## Belum diputuskan

- Font pengganti final (usulan: Archivo / Assistant / Space Mono) — bisa dicoba di Rilis 1 lalu disesuaikan.
- Isi teks & foto awal storefront Rilis 1 (judul banner, poin keunggulan, cerita, foto banner).
- Matriks RBAC lengkap per role & halaman (sebelum Rilis 2).
