#!/bin/sh
# Logical backup of the Lobbyup database (pg_dump custom format).
#
#   BACKUP_DATABASE_URL=postgresql://owner:***@host/db?sslmode=require \
#   BACKUP_DIR=/var/backups/lobbyup BACKUP_GPG_RECIPIENT=ops@example.edu \
#   sh scripts/backup-db.sh
#
# - Verifies the archive is readable before keeping it.
# - Encrypts with GPG when BACKUP_GPG_RECIPIENT is set (strongly recommended: dumps contain
#   student data). Without it the dump is kept unencrypted with 0600 permissions and a warning.
# - Writes a SHA-256 checksum next to the file and prunes backups older than
#   BACKUP_RETENTION_DAYS (default 14).
# Schedule it (cron/systemd timer) and copy the output OFF the database host.
#
# Credentials: prefer a password-less URL plus PGPASSWORD or ~/.pgpass, so the password does not
# appear in the process list (`ps`) while pg_dump runs.
set -eu

DB_URL="${BACKUP_DATABASE_URL:-${DIRECT_DATABASE_URL:-}}"
[ -n "$DB_URL" ] || { echo "Set BACKUP_DATABASE_URL (or DIRECT_DATABASE_URL)." >&2; exit 1; }
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"

umask 077
mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
base="lobbyup-$stamp.dump"
tmp="$BACKUP_DIR/$base.partial"
# Never leave a (plaintext) partial dump behind if anything below fails.
trap 'rm -f "$tmp"' EXIT INT TERM

pg_dump --format=custom --compress=9 --no-owner --no-privileges --dbname="$DB_URL" --file="$tmp"
pg_restore --list "$tmp" > /dev/null # fails if the archive is unreadable

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  final="$base.gpg"
  gpg --batch --yes --encrypt --recipient "$BACKUP_GPG_RECIPIENT" --output "$BACKUP_DIR/$final" "$tmp"
  rm -f "$tmp"
else
  final="$base"
  mv "$tmp" "$BACKUP_DIR/$final"
  echo "WARNING: backup is NOT encrypted (set BACKUP_GPG_RECIPIENT)." >&2
fi

(cd "$BACKUP_DIR" && sha256sum "$final" > "$final.sha256")
find "$BACKUP_DIR" -type f -name 'lobbyup-*' -mtime +"$RETENTION_DAYS" -delete
echo "$BACKUP_DIR/$final"
