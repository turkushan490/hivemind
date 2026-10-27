#!/bin/bash
# Auto-deploy for HiveMind on Unraid: run every 15 minutes from the User Scripts plugin.
# Pulls the newest image, recreates the container from its template and checks /api/health.
# If the new version does not come up healthy, it rolls back to the previous image,
# remembers the bad version (so it is not retried) and sends an Unraid notification.
set -uo pipefail

NAME="${1:-hivemind}"
IMAGE="ghcr.io/turkushan490/hivemind:latest"
PREVIOUS="ghcr.io/turkushan490/hivemind:previous"
HEALTH="http://localhost:4820/api/health"
STATE=/mnt/user/appdata/hivemind
LOG="$STATE/auto-update.log"
BAD="$STATE/auto-update.bad"
REBUILD=/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container
NOTIFY=/usr/local/emhttp/webGui/scripts/notify

log() { echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
notify() { "$NOTIFY" -e "HiveMind auto-update" -s "$1" -d "$2" -i "$3" >/dev/null 2>&1 || true; }
healthy() {
  for _ in $(seq 1 24); do
    curl -fsS -m 5 "$HEALTH" >/dev/null 2>&1 && return 0
    sleep 5
  done
  return 1
}

old=$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)
if ! docker pull -q "$IMAGE" >/dev/null 2>&1; then
  log "Pull failed (GitHub unreachable?), trying again next time."
  exit 0
fi
new=$(docker image inspect "$IMAGE" --format '{{.Id}}')
[ "$old" = "$new" ] && exit 0

if [ -f "$BAD" ] && grep -qx "$new" "$BAD"; then
  # This version failed before: keep running the old one.
  [ -n "$old" ] && docker tag "$old" "$IMAGE"
  exit 0
fi

prevprev=$(docker image inspect "$PREVIOUS" --format '{{.Id}}' 2>/dev/null || true)
[ -n "$old" ] && docker tag "$old" "$PREVIOUS"
log "New version ${new:7:12} found, deploying..."
"$REBUILD" "$NAME" >/dev/null 2>&1

if healthy; then
  version=$(curl -fsS -m 5 "$HEALTH" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
  log "Deployed ${new:7:12} (version ${version:-?}), health OK."
  notify "Updated" "HiveMind updated to ${version:0:7}" normal
  # Remove the version before the previous one; keep :previous for a rollback.
  if [ -n "$prevprev" ] && [ "$prevprev" != "$old" ] && [ -z "$(docker ps -aq --filter "ancestor=$prevprev")" ]; then
    docker rmi "$prevprev" >/dev/null 2>&1 || true
  fi
  exit 0
fi

log "New version ${new:7:12} is NOT healthy, rolling back."
echo "$new" >>"$BAD"
docker logs --tail 40 "$NAME" >>"$LOG" 2>&1
if [ -n "$old" ]; then
  docker tag "$old" "$IMAGE"
  "$REBUILD" "$NAME" >/dev/null 2>&1
  if healthy; then log "Rolled back to ${old:7:12}, health OK."; else log "Rollback is not healthy either!"; fi
fi
docker rmi "$new" >/dev/null 2>&1 || true
notify "Update failed, rolled back" "New HiveMind version did not start. Log: $LOG" alert
