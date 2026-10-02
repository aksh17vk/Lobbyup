#!/bin/sh
# Restore a backup made by backup-db.sh into an EMPTY database, then switch the app over.
#
#   createdb lobbyup_restored            # (or create it in your provider's console)
#   RESTORE_DATABASE_URL=postgresql://owner:***@host/lobbyup_restored CONFIRM_RESTORE=yes \
#   sh scripts/restore-db.sh /var/backups/lobbyup/lobbyup-20261003T020000Z.dump.gpg
#
# Restoring into a fresh database (instead of overwriting the live one in place) is what makes a
# rollback safe even when the live schema is newer than the backup. The restore runs in a single
# transaction: it either fully succeeds or leaves the target untouched.
# Afterwards: run `pnpm db:roles` against the restored database, then point DATABASE_URL and
# DIRECT_DATABASE_URL at it.
set -eu

file="${1:?usage: restore-db.sh <backup file>}"
[ -n "${RESTORE_DATABASE_URL:-}" ] || { echo "Set RESTORE_DATABASE_URL (an empty target database)." >&2; exit 1; }
[ "${CONFIRM_RESTORE:-}" = "yes" ] || { echo "Refusing to run without CONFIRM_RESTORE=yes." >&2; exit 1; }

existing=$(psql --no-psqlrc -tAc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')" "$RESTORE_DATABASE_URL")
if [ "$existing" != "0" ]; then
  echo "Refusing: the target database already has $existing tables. Restore into a new, empty database." >&2
  exit 1
fi

dir=$(dirname "$file")
name=$(basename "$file")
if [ -f "$file.sha256" ]; then
  (cd "$dir" && sha256sum -c "$name.sha256")
else
  echo "WARNING: no checksum file found next to the backup." >&2
fi

umask 077
src="$file"
case "$file" in
  *.gpg)
    src="${file%.gpg}.decrypted"
    # The decrypted copy is plaintext student data: remove it however this script ends.
    trap 'rm -f "$src"' EXIT INT TERM
    gpg --batch --yes --decrypt --output "$src" "$file"
    ;;
esac

pg_restore --no-owner --no-privileges --single-transaction --exit-on-error --dbname="$RESTORE_DATABASE_URL" "$src"
echo "Restore complete. Next: run 'pnpm db:roles' against this database, then switch the app's URLs to it."
