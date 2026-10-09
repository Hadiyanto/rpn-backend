# Plan: Lepas dari Vercel, Render, Supabase & Upstash (full VPS + Postgres)

Status: **rencana** · dibuat 2026-10-09

Tujuan: semua berjalan di VPS sendiri — frontend, backend, database, login — dengan data di Postgres
VPS dan backup di R2. Tidak ada lagi ketergantungan ke Vercel, Render, dan Supabase.

> **Keputusan 2026-10-09:** Fase 3 (Redis di VPS, lepas Upstash) **ditunda**. Upstash tetap dipakai
> untuk kuota, cache, dan sesi WhatsApp sampai diputuskan lain.

---

## 1. Kondisi sekarang

| Komponen | Sekarang | Dipakai untuk | Target |
|---|---|---|---|
| Database | **Postgres VPS** (`shared-postgres`, `rpn_db`) ✔ | semua data aplikasi | tetap |
| Backup DB | `pg-backup` → R2 (tiap jam) ✔ | | tetap; buang opsi restore ke Supabase |
| Backend | **Docker di VPS** (`api-rpn.ruangin.xyz`) ✔ — *Render masih ada* (`infra/render.yaml`) | API | VPS saja; Render dimatikan |
| Frontend | **Vercel** (`rpn-frontend-omega.vercel.app`) | admin + form order | Docker di VPS, `rajapisangnugget.com` (branch `feat/vps-deployment` sudah siap) |
| Login | **Supabase Auth** (email + password, 3 user admin) | login admin, sesi, logout | login sendiri di Postgres |
| Role | tabel `user_roles` di Postgres (user_id = id user Supabase) | halaman yang boleh dibuka | digabung ke tabel `users` baru |
| Redis | **Upstash** (dipakai bareng app lain; RPN di `rpn:*`) | kuota harian/jam, cache menu/varian, **sesi WhatsApp** | Redis di VPS (atau Postgres, lihat §4) |
| Script lama | `src/config/supabase.ts`, `import_variants.ts`, `update_roles.ts` | — | dihapus |

### ⚠️ Temuan penting: API backend tidak dilindungi login

Login Supabase sekarang **hanya di frontend** (middleware Next.js + menyembunyikan halaman). Backend
tidak memeriksa login sama sekali: siapa pun yang tahu URL API bisa membaca order (nama, nomor WA,
alamat customer), mengubah status order, stok, gaji, keuangan, dan role user. Mengganti login
**wajib** sekalian menambahkan pemeriksaan sesi di backend — ini bagian terpenting dari plan ini.

---

## 2. Urutan fase

| Fase | Isi | Risiko | Perkiraan |
|---|---|---|---|
| 0 | Persiapan: backup, DNS, keputusan (§7) | rendah | ½ hari |
| 1 | Frontend pindah ke VPS + API satu domain | rendah | ½–1 hari |
| 2 | Login sendiri di Postgres + proteksi API | **tinggi** (bisa terkunci / API terbuka) | 2–3 hari |
| ~~3~~ | ~~Redis self-host, Upstash dilepas~~ — **ditunda** | sedang (sesi WA) | 1 hari |
| 4 | Matikan Render, Vercel, Supabase, Upstash + bersih-bersih | rendah | ½ hari |
| 5 | Operasional VPS (monitoring, log, restore drill) | rendah | ½ hari |

Urutan yang dijalankan: **Fase 0 → 1 → 2 → 4 → 5**. Fase 3 menyusul kalau Upstash jadi dilepas.

---

## 3. Fase 1 — Frontend ke VPS, API satu domain

Sudah disiapkan: branch `feat/vps-deployment` di rpn-frontend (Dockerfile standalone,
`docker-compose.yml` di `127.0.0.1:3000`) dan repo **setupvps** (site nginx
`rajapisangnugget.com`, `setup-nginx.sh`, runbook ganti VPS, daftar port). Tambahan untuk plan ini:

**Keputusan: API di subdomain `api.rajapisangnugget.com`** (`NEXT_PUBLIC_API_URL=https://api.rajapisangnugget.com`).
- Frontend dan API beda *origin* tapi satu *site* (`rajapisangnugget.com`): CORS tetap dibutuhkan
  (`DOCKER_CORS_ORIGINS=https://rajapisangnugget.com`), cookie login (Fase 2) tetap *first-party*
  dengan `Domain=.rajapisangnugget.com; SameSite=Lax` — tidak kena blokir cookie lintas situs.
- `api-rpn.ruangin.xyz` tetap hidup sementara (legacy); URL notifikasi DOKU dipindah ke
  `https://api.rajapisangnugget.com/api/payments/doku/notification`.

Langkah:
1. DNS `rajapisangnugget.com`, `www`, `api` → IP VPS; sertifikat SSL (`*.rajapisangnugget.com`).
2. nginx: `setupvps/nginx/rpn/` (`rajapisangnugget.com` → 3000, `api.rajapisangnugget.com` → 3001)
   → `./04-nginx.sh rpn`.
3. `rpn-frontend/.env` di VPS → `docker compose up -d --build`.
4. Backend `.env`: `DOCKER_FRONTEND_URL=https://rajapisangnugget.com`, tambahkan ke `DOCKER_CORS_ORIGINS`.
5. Supabase Auth URL config + Google API key referrer → domain baru (selama Fase 2 belum jalan).
6. Uji: order customer (pickup, Store Delivery, DOKU), login admin, PWA.
7. Vercel dibiarkan hidup ±1 minggu sebagai cadangan, lalu dimatikan (Fase 4).

---

## 4. Fase 2 — Login sendiri di Postgres + proteksi API

### 4.1 Database (migration baru)

```sql
-- user admin: menggantikan Supabase auth.users + user_roles
users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),   -- pakai id lama dari user_roles
  email         text NOT NULL UNIQUE,                           -- disimpan lowercase
  password_hash text NOT NULL,                                  -- scrypt (node:crypto), lihat 4.2
  role          varchar(50) NOT NULL DEFAULT 'staff',
  allowed_pages text[] NOT NULL DEFAULT '{orders}',
  is_active     boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at / updated_at
)

-- sesi login: bisa dicabut (logout, nonaktifkan user) — beda dengan JWT
sessions (
  id           bigserial PRIMARY KEY,
  token_hash   bytea NOT NULL UNIQUE,     -- sha256(token); token mentah hanya ada di cookie
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  user_agent   text, ip inet, created_at
)
```

- Data `user_roles` (3 admin) disalin ke `users` dengan **id yang sama**; `user_roles` dihapus
  setelah semua jalan.
- Sesi kedaluwarsa dibersihkan saat login / berkala.

### 4.2 Backend

- **Hash password**: `scrypt` bawaan `node:crypto` (tanpa dependency baru), salt per user,
  format `scrypt$N$r$p$salt$hash`; perbandingan `timingSafeEqual`.
- **Endpoint**:
  - `POST /api/auth/login` `{ email, password }` → set cookie, kembalikan profil + `allowed_pages`.
    Rate limit ketat (mis. 5× / 15 menit per IP+email), pesan error generik.
  - `POST /api/auth/logout` → hapus sesi + cookie.
  - `GET /api/auth/me` → profil + `allowed_pages` (pengganti `GET /user-role/:userId`).
- **Cookie**: `rpn_session`, `HttpOnly; Secure; SameSite=Lax; Path=/; Domain=.rajapisangnugget.com`,
  masa berlaku 30 hari, diperpanjang otomatis saat dipakai. CORS backend: `credentials: true` dengan
  origin persis `https://rajapisangnugget.com`.
- **Middleware** `requireAuth` di semua route, kecuali daftar publik (dipakai form order customer
  & webhook):

  | Publik (tanpa login) | Catatan |
  |---|---|
  | `GET /health` | |
  | `GET /stores`, `GET /stores/:id` | hanya field yang dibutuhkan customer |
  | `GET /menu`, `GET /variants`, `GET /variants/best-sellers` | |
  | `GET /daily-quota`, `GET /hourly-quota/availability` | |
  | `POST /orders/quote`, `POST /order` | `POST /order` dari admin tetap jalan (sesi opsional) |
  | `GET /payment/config` | |
  | `POST /biteship/eligibility`, `POST /biteship/store-delivery-options`, `GET /biteship/areas` | |
  | `GET/PATCH /order/public/:token…`, `POST /order/public/:token/doku-sync` | by public token |
  | `POST /upload-image` | bukti transfer; tetap dibatasi ukuran/tipe |
  | `POST /payments/doku/notification` | dilindungi signature DOKU |

  Semua sisanya (order list/detail/status, stok, gaji, keuangan, config, store edit, push
  subscribe, WhatsApp, Biteship order manual, user role) wajib login.
- **Izin per halaman di server**: `requirePage('stock')`, `requirePage('salary')`, dst. sesuai
  `allowed_pages` — sekarang pembatasan ini hanya di frontend.
- `GET /order/:id` (angka) tidak lagi dipakai halaman bukti transfer publik — hanya
  `/order/public/:token`.
- **Kelola user**: script `scripts/user.ts create|reset-password|disable <email>`; halaman
  "Pengguna" di admin bisa menyusul.
- **Peluncuran bertahap** dengan env `AUTH_MODE`:
  1. `off` — endpoint login sudah ada, API belum dikunci (deploy backend dulu).
  2. `log` — request tanpa sesi ke route admin dicatat di log tapi tetap dilayani (cek tidak ada
     halaman yang terlewat).
  3. `enforce` — 401 untuk route admin tanpa sesi.

### 4.3 Frontend

- `app/login/page.tsx` → `POST /api/auth/login`.
- `hooks/useUserRole.ts` → `GET /api/auth/me`.
- `components/Sidebar.tsx` logout → `POST /api/auth/logout`.
- `utils/fetchJson.ts` → `credentials: 'include'` (cukup di satu tempat; panggilan `fetch`
  langsung ikut disesuaikan).
- `middleware.ts` → hanya cek ada/tidaknya cookie `rpn_session` untuk redirect ke `/login`;
  validasi sebenarnya di backend (401 → redirect ke login). Sekalian perbaiki: `/sw.js`,
  `/js/*`, `/json/manifest.json` jangan ikut di-redirect (PWA customer).
- Hapus `@supabase/ssr`, `utils/supabase/*`, `app/auth/callback`, env `NEXT_PUBLIC_SUPABASE_*`.

### 4.4 Migrasi user

Rekomendasi: **set password baru** untuk 3 admin lewat `scripts/user.ts` (dikirim langsung ke
orangnya). Alternatif: impor hash bcrypt dari Supabase (`auth.users.encrypted_password`) supaya
password lama tetap berlaku — butuh dependency bcrypt dan migrasi hash saat login; tidak sepadan
untuk 3 user.

### 4.5 Uji

- Integration test: login benar/salah, rate limit, sesi kedaluwarsa, logout mencabut sesi, user
  nonaktif, route publik tetap terbuka, route admin 401 tanpa sesi, `requirePage`.
- Manual di HP (Safari iOS + Chrome Android): login, refresh, logout, order customer tanpa login.

---

## 5. Fase 3 — Redis di VPS (Upstash dilepas) — **DITUNDA**

Disimpan sebagai referensi; tidak dikerjakan sekarang. Upstash tetap dipakai.

Yang disimpan di Redis: kuota harian/jam (`rpn:quota:*`, bisa dihitung ulang dari order), cache
menu/varian (`rpn:cache:*`, boleh hilang), **sesi WhatsApp** (`rpn:wa:*`, kalau hilang harus scan QR
ulang).

| Opsi | Perubahan kode | Catatan |
|---|---|---|
| **A. Redis container + `ioredis`** (rekomendasi) | adapter kecil di `utils/redis.ts` untuk perintah yang dipakai (`get/set nx ex/del/incrbyfloat/mget/hmget/exists/scan/renamenx/pipeline`) | standar, cepat, tanpa HTTP |
| B. Redis container + SRH (adapter REST Upstash) | **tidak ada** — `@upstash/redis` tetap, URL diarahkan ke SRH | paling cepat; sudah dipakai saat tes lokal; 1 container tambahan |
| C. Tanpa Redis, semua di Postgres | besar: kuota jadi counter SQL atomik, sesi WA ke tabel | komponen paling sedikit; kerjakan nanti kalau mau |

Langkah (opsi A/B):
1. Service `redis` (redis:7-alpine, `appendonly yes`, `requirepass`) di `docker-compose.yml`
   backend, hanya di network internal — **tidak** dipublish ke host.
2. Script salin `rpn:wa:*` dari Upstash ke Redis baru (SCAN + DUMP/RESTORE atau GET/SET), jalankan
   saat backend dihentikan sebentar → WhatsApp tidak perlu scan ulang.
3. Ganti env, restart backend, `scripts/resync-quotas.ts` untuk membangun ulang kuota.
4. Cek: order baru mengurangi kuota, WhatsApp terkirim, menu tampil.
5. Upstash dipakai bareng app lain (`resident:*`, `testdoc:*`) → yang dihapus **hanya** `rpn:*`.

---

## 6. Fase 4 & 5 — Mematikan layanan lama, operasional

**Matikan** (setelah masing-masing jalan stabil ±1 minggu):
- **Render**: hapus service (pastikan dulu WhatsApp aktif di VPS: `WHATSAPP_DISABLED=false`, dan
  Render sudah mati supaya tidak rebutan sesi WA). Hapus `infra/render.yaml`.
- **Vercel**: hapus project setelah DNS pindah dan tidak ada traffic.
- **Supabase**: simpan daftar user untuk arsip, lalu pause/hapus project. Hapus
  `src/config/supabase.ts`, `@supabase/supabase-js`, `import_variants.ts`, `update_roles.ts`, env
  `SUPABASE_*`, opsi `SUPABASE_DB_URL`/`RESTORE_TO_SUPABASE` di `tools/db-backup`.
- **Upstash**: **tetap dipakai** (Fase 3 ditunda); env `UPSTASH_*` dipertahankan.
- README/`.env.example` diperbarui.

**Operasional VPS** (semua sekarang di satu server):
- Backup: `pg-backup` → R2 tiap jam ✔; **uji restore** sekali (ke DB kosong) dan catat langkahnya.
- Redis: AOF aktif; sesi WA ikut di-backup (`BGSAVE`/salin `appendonly` ke R2 harian) atau cukup
  scan QR ulang bila hilang.
- Log Docker: `logging: { driver: json-file, options: { max-size: 10m, max-file: "3" } }`.
- Monitoring: uptime check gratis (mis. UptimeRobot) ke `/health` dan halaman utama; notifikasi ke
  email/WA.
- Sumber daya: frontend ±60 MB, backend + Redis kecil; cek RAM VPS bersama poc-news.
- Risiko utama: **satu VPS = satu titik gagal**. Mitigasi: backup R2 + langkah restore tertulis.

Layanan eksternal yang **tetap** dipakai (bukan bagian plan ini): Cloudflare R2, Cloudinary (foto),
Biteship, DOKU, Google Maps, WhatsApp (Baileys).

---

## 7. Keputusan yang perlu diambil

1. ~~**Domain API**~~ — diputuskan: `api.rajapisangnugget.com`.
2. **Password admin**: set baru (rekomendasi) atau impor hash dari Supabase.
3. ~~**Redis**: opsi A (rekomendasi), B, atau C.~~ Ditunda — Upstash tetap.
4. **Kelola user**: script dulu (rekomendasi) atau langsung halaman "Pengguna".
5. **Urutan**: Fase 1 → 2 → 4 → 5 (Fase 3 ditunda).
