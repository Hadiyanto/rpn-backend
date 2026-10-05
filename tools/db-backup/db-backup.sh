#!/usr/bin/env bash
#
# Backup Postgres (pg_dump) berkala + restore opsional ke Supabase sebagai salinan cadangan.
# Dipakai container pg-backup (docker-compose.yml); bisa juga dijalankan manual.
#
#   db-backup.sh loop                    backup tiap BACKUP_INTERVAL_SECONDS (default 3600)
#   db-backup.sh once                    backup sekali (+ restore ke Supabase bila RESTORE_TO_SUPABASE=true)
#   db-backup.sh restore <file> [url]    restore file backup ke url (default SUPABASE_DB_URL)
#   db-backup.sh list                    daftar file backup lokal
#   db-backup.sh r2-list                 daftar backup di R2
#   db-backup.sh r2-get <key>            unduh backup dari R2 ke BACKUP_DIR (lalu bisa di-restore)
#
# Env:
#   DATABASE_URL            sumber backup (Postgres utama; di compose = DOCKER_DATABASE_URL)
#   SUPABASE_DB_URL         target restore (Supabase: Session pooler port 5432, bukan 6543)
#   RESTORE_TO_SUPABASE     true = restore otomatis setelah setiap backup berhasil
#   BACKUP_DIR              default /backups
#   BACKUP_KEEP_DAYS        default 14; backup lokal lebih tua dihapus (minimal 3 terakhir selalu disimpan)
#   R2_BACKUP_BUCKET        bucket R2 PRIVAT untuk backup (bukan bucket media publik). Kosong = tidak diunggah.
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY   kredensial R2 (tools/db-backup/.env)
#
# Nama file: <nama-db>_YYYY-MM-DD_HH-MM-SS_WIB.dump, mis. rpn_db_2026-10-05_21-30-05_WIB.dump.
# Di R2 disimpan di backups/YYYY/MM/<nama file>. Hapus otomatis di R2 diatur lewat lifecycle rule bucket.
#
# Yang di-backup: schema public saja (tabel aplikasi). Schema lain di Supabase (auth, storage, dst.)
# tidak disentuh saat restore.
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-3600}"

export TZ="${TZ:-Asia/Jakarta}"
log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S %Z')" "$*"; }
fail() { log "GAGAL: $*"; return 1; }
host_of() { sed -E 's#^[a-z]+://([^@/]*@)?([^:/?]+).*#\2#' <<<"$1"; }
count() { psql "$1" -XAtqc "SELECT count(*) FROM orders" 2>/dev/null || echo "?"; }
db_name() { sed -E 's#^[a-z]+://[^/]*/([^/?]+).*#\1#' <<<"$1"; }

r2_ready() { [[ -n "${R2_BACKUP_BUCKET:-}" && -n "${R2_ACCOUNT_ID:-}" && -n "${R2_ACCESS_KEY_ID:-}" && -n "${R2_SECRET_ACCESS_KEY:-}" ]]; }

# aws-cli ke endpoint R2. Pemeriksaan checksum baru di aws-cli dibatasi ke "when_required"
# supaya kompatibel dengan R2.
r2() {
  AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=auto \
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
    aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" --only-show-errors "$@"
}

upload_r2() {
  local file="$1"
  if ! r2_ready; then
    log "R2: dilewati (R2_BACKUP_BUCKET atau kredensial R2 kosong)"
    return 0
  fi
  if [[ -n "${R2_BUCKET_NAME:-}" && "$R2_BACKUP_BUCKET" == "$R2_BUCKET_NAME" ]]; then
    fail "R2_BACKUP_BUCKET sama dengan bucket media publik ($R2_BUCKET_NAME); backup TIDAK diunggah. Pakai bucket privat terpisah."
    return 1
  fi
  local key="backups/$(date +%Y/%m)/$(basename "$file")"
  if r2 s3 cp "$file" "s3://$R2_BACKUP_BUCKET/$key"; then
    log "R2: diunggah ke $R2_BACKUP_BUCKET/$key"
  else
    fail "R2: unggah gagal; backup lokal tetap ada"
  fi
}

backup() {
  : "${DATABASE_URL:?DATABASE_URL wajib diisi}"
  mkdir -p "$BACKUP_DIR"
  local file="$BACKUP_DIR/$(db_name "$DATABASE_URL")_$(date +%Y-%m-%d_%H-%M-%S)_WIB.dump"
  log "Backup $(host_of "$DATABASE_URL") -> $file"
  pg_dump --dbname="$DATABASE_URL" --format=custom --schema=public --no-owner --no-privileges --file="$file.tmp" \
    || { rm -f "$file.tmp"; fail "pg_dump gagal"; return 1; }
  pg_restore --list "$file.tmp" >/dev/null || { rm -f "$file.tmp"; fail "file backup rusak"; return 1; }
  mv "$file.tmp" "$file"
  log "Backup selesai: $(du -h "$file" | cut -f1), $(count "$DATABASE_URL") order"

  # hapus backup lama, tapi selalu sisakan 3 terbaru
  ls -1t "$BACKUP_DIR"/*.dump 2>/dev/null | tail -n +4 | while read -r old; do
    if [[ -n "$(find "$old" -mtime +"$KEEP_DAYS")" ]]; then
      rm -f "$old" && log "Dihapus (> $KEEP_DAYS hari): $(basename "$old")"
    fi
  done

  upload_r2 "$file" || true

  if [[ "${RESTORE_TO_SUPABASE:-false}" == "true" ]]; then
    restore "$file" "${SUPABASE_DB_URL:-}"
  fi
}

restore() {
  local file="${1:-}" target="${2:-${SUPABASE_DB_URL:-}}"
  [[ -f "$file" ]] || { fail "file backup tidak ada: $file"; return 1; }
  [[ -n "$target" ]] || { fail "target restore kosong (SUPABASE_DB_URL)"; return 1; }
  if [[ -n "${DATABASE_URL:-}" && "$(host_of "$target")" == "$(host_of "$DATABASE_URL")" && "${target%%\?*}" == "${DATABASE_URL%%\?*}" ]]; then
    fail "target restore sama dengan database sumber; dibatalkan"; return 1
  fi

  local version
  version="$(psql "$target" -XAtqc "SHOW server_version_num" 2>&1)" || { fail "tidak bisa terhubung ke target: $version"; return 1; }
  log "Restore $(basename "$file") -> $(host_of "$target") (Postgres $((version / 10000)))"

  # Satu transaksi: kalau ada satu error, semua dibatalkan dan isi target tidak berubah.
  # --clean --if-exists: hapus tabel lama di schema public sebelum dibuat ulang.
  # Jangan sentuh schema public itu sendiri (di Supabase punya hak akses bawaan):
  # hanya objek aplikasi di dalamnya yang dihapus & dibuat ulang.
  local toc ok
  toc="$(mktemp)"
  pg_restore --list "$file" | grep -v ' SCHEMA - public ' > "$toc"

  if (( version >= 170000 )); then
    pg_restore --dbname="$target" --use-list="$toc" --clean --if-exists --no-owner --no-privileges \
      --single-transaction --exit-on-error "$file" && ok=1
  else
    # Target lebih tua dari pg_dump 17 (mis. Supabase PG 15): ubah ke SQL dan buang
    # pengaturan yang belum dikenal versi lama.
    pg_restore --file=- --use-list="$toc" --clean --if-exists --no-owner --no-privileges "$file" \
      | sed -E '/^SET transaction_timeout/d' \
      | psql "$target" -Xq -v ON_ERROR_STOP=1 --single-transaction >/dev/null && ok=1
  fi
  rm -f "$toc"
  if [[ -n "${ok:-}" ]]; then
    log "Restore selesai: target $(count "$target") order (sumber $(count "${DATABASE_URL:-$target}"))"
  else
    fail "restore gagal; isi target tidak berubah"
  fi
}

case "${1:-loop}" in
  once) backup ;;
  restore) restore "${2:-}" "${3:-}" ;;
  list) ls -lh "$BACKUP_DIR"/*.dump 2>/dev/null || echo "belum ada backup di $BACKUP_DIR" ;;
  r2-list) r2_ready || { fail "R2 belum dikonfigurasi"; exit 1; }; r2 s3 ls "s3://$R2_BACKUP_BUCKET/backups/" --recursive ;;
  r2-get)
    r2_ready || { fail "R2 belum dikonfigurasi"; exit 1; }
    [[ -n "${2:-}" ]] || { fail "pakai: r2-get backups/YYYY/MM/<file>.dump"; exit 1; }
    mkdir -p "$BACKUP_DIR" && r2 s3 cp "s3://$R2_BACKUP_BUCKET/$2" "$BACKUP_DIR/$(basename "$2")" && log "Diunduh: $BACKUP_DIR/$(basename "$2")"
    ;;
  loop)
    log "pg-backup: backup setiap ${INTERVAL} detik, simpan ${KEEP_DAYS} hari, R2: $(r2_ready && echo "$R2_BACKUP_BUCKET" || echo tidak), restore ke Supabase: ${RESTORE_TO_SUPABASE:-false}"
    while true; do
      backup || true
      sleep "$INTERVAL"
    done
    ;;
  *) echo "pakai: $0 loop|once|restore <file> [url]|list|r2-list|r2-get <key>" >&2; exit 1 ;;
esac
