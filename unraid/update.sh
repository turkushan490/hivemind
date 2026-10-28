#!/bin/bash
# Update HiveMind on Unraid the same way the Docker tab does, and remove the old image afterwards
# so no "(orphan image)" entries pile up.
# Usage (on the Unraid server): bash update.sh [container-name]
set -euo pipefail

NAME="${1:-hivemind}"
IMAGE="ghcr.io/turkushan490/hivemind:latest"
REBUILD=/usr/local/emhttp/plugins/dynamix.docker.manager/scripts/rebuild_container

old=$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null || true)
docker pull -q "$IMAGE" >/dev/null
new=$(docker image inspect "$IMAGE" --format '{{.Id}}')

if [ "$old" = "$new" ]; then
  echo "Already up to date."
  exit 0
fi

# Stop it cleanly first: rebuild_container force-removes a running container, which HiveMind would
# report as a crash at the next start.
docker stop -t 30 "$NAME" >/dev/null 2>&1 || true
# Recreate the container from its Unraid template (keeps Edit, icon and autostart working).
"$REBUILD" "$NAME" >/dev/null 2>&1

# Remove the previous version once nothing uses it any more.
if [ -n "$old" ] && [ -z "$(docker ps -aq --filter "ancestor=$old")" ]; then
  docker rmi "$old" >/dev/null && echo "Removed old image ${old:7:12}."
fi
echo "Updated to ${new:7:12}."
