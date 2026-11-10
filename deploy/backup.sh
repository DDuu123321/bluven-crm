#!/bin/sh
# Backs up the database and the uploaded files of the Docker Compose stack.
#
#   ./deploy/backup.sh [target directory]      (default: ./backups)
#
# Run it from the directory that holds docker-compose.yml, for example nightly from cron:
#   15 2 * * *  cd /opt/bluven-crm && ./deploy/backup.sh >> backups/backup.log 2>&1
#
# The backups stay on this server. Copy the target directory somewhere else as well
# (another machine or cloud storage): a backup on the same disk does not survive losing the disk.
set -eu

TARGET="${1:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$TARGET"

# A file only gets its final name once it is complete, so an interrupted run never leaves
# something behind that looks like a good backup.
cleanup() { rm -f "$TARGET/db-$STAMP.dump.part" "$TARGET/storage-$STAMP.tar.gz.part"; }
trap cleanup EXIT

echo "[$STAMP] database"
docker compose exec -T db pg_dump -U bluven -d bluven --format=custom > "$TARGET/db-$STAMP.dump.part"

echo "[$STAMP] files"
# A one-off container, so this works whether or not the worker is running.
docker compose run --rm -T --no-deps worker tar -C /data -czf - storage > "$TARGET/storage-$STAMP.tar.gz.part"

mv "$TARGET/db-$STAMP.dump.part" "$TARGET/db-$STAMP.dump"
mv "$TARGET/storage-$STAMP.tar.gz.part" "$TARGET/storage-$STAMP.tar.gz"

# Remove backups older than KEEP_DAYS days. Only reached when today's backup succeeded.
find "$TARGET" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'storage-*.tar.gz' \) -mtime "+$KEEP_DAYS" -delete

echo "[$STAMP] done: $(du -sh "$TARGET" | cut -f1) in $TARGET"
