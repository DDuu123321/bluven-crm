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

echo "[$STAMP] database"
docker compose exec -T db pg_dump -U bluven -d bluven --format=custom > "$TARGET/db-$STAMP.dump"

echo "[$STAMP] files"
docker compose exec -T worker tar -C /data -czf - storage > "$TARGET/storage-$STAMP.tar.gz"

# Remove backups older than KEEP_DAYS days.
find "$TARGET" -maxdepth 1 -type f \( -name 'db-*.dump' -o -name 'storage-*.tar.gz' \) -mtime "+$KEEP_DAYS" -delete

echo "[$STAMP] done: $(ls -1 "$TARGET" | wc -l) files in $TARGET"
