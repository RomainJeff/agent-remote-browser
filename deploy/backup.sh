#!/bin/sh
# Backs up the stack into a restic repository: a consistent arb.db snapshot (`cli.ts backup-db`, safe while the
# gateway runs) and, with BACKUP_PROFILES=1, a tar of every browser profile volume (cookies, local storage).
# Run from the repository checkout, as a user that can reach the Docker daemon, e.g. from cron:
#   17 3 * * * cd /opt/agent-remote-browser && RESTIC_REPOSITORY=... RESTIC_PASSWORD_FILE=/root/.arb-restic deploy/backup.sh
# Required: RESTIC_REPOSITORY, RESTIC_PASSWORD_FILE (plus the repository's own credentials, e.g. AWS_* for S3).
# Optional: COMPOSE_FILE (compose.yaml:compose.tunnel.yaml), ARB_PREFIX, BACKUP_PROFILES=1, KEEP_DAILY (default 30).
# NOT backed up here, on purpose: secrets/login_key and secrets/better_auth_secret. A backup holding both arb.db
# and the login key would hold every saved password. Keep them, and the restic password, somewhere else
# (password manager, offline copy): deploy/runbook.md, section 9.
set -eu
: "${RESTIC_REPOSITORY:?set RESTIC_REPOSITORY}" "${RESTIC_PASSWORD_FILE:?set RESTIC_PASSWORD_FILE}"
P=${ARB_PREFIX:-arb}
STAGE=${BACKUP_STAGE:-/var/tmp/$P-backup}
# Throwaway image that tars each profile volume. Pinned by digest, like every image of the stack (Renovate updates it).
COPY_IMAGE='alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f'
umask 077
rm -rf "$STAGE" && mkdir -p "$STAGE"
trap 'rm -rf "$STAGE"' EXIT

# arb.db: snapshot inside the gateway (tmpfs /tmp), streamed out, removed. Never a copy of the live file and its -wal.
docker compose exec -T gateway sh -c 'f=/tmp/arb-backup.db; rm -f $f; node src/cli.ts backup-db $f >&2 && cat $f; rm -f $f' > "$STAGE/arb.db"
[ -s "$STAGE/arb.db" ] || { echo "empty arb.db snapshot" >&2; exit 1; }

if [ "${BACKUP_PROFILES:-}" = 1 ]; then
  # ponytail: a running browser may be mid-write; Chrome recovers its cookie DB. Stop computers first for an exact copy.
  mkdir "$STAGE/profiles"
  for v in $(docker volume ls -q --filter "label=$P-computer"); do
    docker run --rm --network none --cap-drop ALL --user 10001:10001 -v "$v:/v:ro" "$COPY_IMAGE" tar -C /v -cf - . > "$STAGE/profiles/$v.tar"
  done
fi

restic backup --tag "$P" --host "$P" "$STAGE"
restic forget --tag "$P" --host "$P" --keep-daily "${KEEP_DAILY:-30}" --prune
