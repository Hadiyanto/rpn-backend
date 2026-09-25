# Fase 11: Test, kebersihan repo, pecah halaman FE

**Status:** ⚠️ selesai dengan catatan (pemecahan halaman `/orders` belum dikerjakan)

## Langkah
- [x] **Test integrasi kuota** (`src/services/__tests__/quota.integration.test.ts`, 4 test; Postgres lokal + Redis in-memory):
  - **20 order paralel untuk kuota 10 box → tepat 10 sukses**, sisanya 409, dan counter Redis tepat 0.
  - Batas slot per jam (3) tetap berlaku saat paralel. 5 order yang ditolak di level jam mengembalikan reservasi hariannya (sisa harian 7).
  - Cancel → kuota kembali; un-cancel → terpakai lagi (HALF = 0.5).
  - Edit order pindah tanggal → kuota tanggal lama dan baru sama-sama tersinkron.
  - Keterbatasan: Redis palsu bersifat atomik per operasi seperti Redis asli, tapi latensi jaringan Upstash tidak ikut disimulasikan.
- [x] **`.gitignore`:**
  - Backend: `.DS_Store`, `.codegraph/`, `.rtk/`, `whatsapp-session/`.
  - Frontend: `.codegraph/`, `.rtk/` (`.DS_Store` sudah ada).
  - Tidak ada file sampah yang ter-track, jadi tidak perlu `git rm --cached`.
- [x] **`rpn-backend/README.md`** (sebelumnya kosong): setup, migrate, test (termasuk setup DB lokal), script Redis, dan pointer ke docs.
- [x] **`rpn-backend/.env.example`**: daftar lengkap env yang dibaca kode (placeholder, tanpa secret).
- [x] **`infra/render.yaml`**: `envVars` dilengkapi dengan semua variabel yang dipakai (secret dengan `sync: false`), plus catatan bahwa migration tidak jalan otomatis.
- [x] **Frontend, helper terduplikasi** dipindah ke `utils/format.ts`:
  - `getTodayStr` (6 halaman), `formatRupiah` (3), `formatChipDate` (2), `toTitleCase` (2), `normalizeVariant` (2).
  - Versi yang perilakunya berbeda (`toTitleCase` dan `formatChipDate` di `/orders`, `getTodayStr` di `/orders`) sengaja **tidak** disatukan, supaya tampilan tidak berubah.
- [x] Ukuran halaman: `app/page.tsx` 1013 → 944, `app/orders/page.tsx` 1385 → 1308, `app/pesan/page.tsx` 897 → 812 baris. Sebagian besar dari `FlavorPicker` (Fase 04).
- [ ] **Belum:** memecah JSX `/orders` (form order, kartu order, filter) menjadi komponen. Tanpa pengujian visual/E2E, refactor JSX sebesar ini berisiko mengubah tampilan tanpa ketahuan. Saran: kerjakan bersama sesi uji UI manual, atau setelah ada Playwright.

## Verifikasi akhir
- [x] Backend: `tsc --noEmit` bersih; `npm run build` sukses (tanpa file test di `dist/`); `npm test` 68 lulus + 41 di-skip (integration); `npm run test:db` **109 lulus** (juga di `TZ=UTC`).
- [x] Frontend: `tsc --noEmit` bersih; lint **197** (baseline 205, tidak ada error baru); `npm run build` sukses.
