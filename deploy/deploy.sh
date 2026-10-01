#!/usr/bin/env bash
# Deploys one commit of main to this server. Installed as /opt/fwtracker/bin/deploy.sh.
#
# GitHub Actions runs it over SSH with a key that can do nothing else: the
# deploy user's authorized_keys entry is
#   command="/opt/fwtracker/bin/deploy.sh",restrict ssh-ed25519 AAAA... github-actions-deploy
# so the commit arrives as SSH_ORIGINAL_COMMAND ("deploy <sha>"), and no shell,
# port forwarding or other command is possible with that key.
#
# Steps: fetch -> check the commit is on origin/main -> apply new migrations ->
# build -> switch -> health check -> roll back to the previous images if the
# new ones aren't healthy. A failed build or migration leaves the running
# version untouched.
#
# Everything is inside main() so bash has read the whole script before any step
# runs (the script replaces its own installed copy at the end).

set -euo pipefail

main() {
  local APP=/opt/fwtracker/app
  local COMPOSE="docker compose -f $APP/deploy/docker-compose.yml"
  local REQ="${SSH_ORIGINAL_COMMAND:-${*:-}}"

  exec 9>/opt/fwtracker/deploy.lock
  if ! flock -n 9; then echo "Another deploy is in progress."; exit 75; fi

  if [[ "$REQ" == "status" ]]; then
    git -C "$APP" log -1 --format='deployed: %h %s (%cd)'
    $COMPOSE ps --format '{{.Name}}: {{.Status}}'
    exit 0
  fi

  local SHA
  SHA=$(sed -n 's/^deploy \([0-9a-f]\{7,40\}\)$/\1/p' <<<"$REQ")
  if [[ -z "$SHA" ]]; then echo "Usage: deploy <commit-sha> | status"; exit 64; fi

  log() { echo "[$(date -u +%H:%M:%S)] $*"; }

  log "deploy $SHA requested"
  git -C "$APP" fetch --quiet origin main
  if ! git -C "$APP" merge-base --is-ancestor "$SHA" origin/main; then
    log "refused: $SHA is not on origin/main"; exit 1
  fi
  local PREV
  PREV=$(git -C "$APP" rev-parse HEAD)
  git -C "$APP" checkout --quiet --detach "$SHA"

  restore_checkout() { git -C "$APP" checkout --quiet --detach "$PREV"; }

  log "building images"
  if ! $COMPOSE build; then
    log "build failed: still running $(git -C "$APP" rev-parse --short "$PREV")"
    restore_checkout; exit 1
  fi

  # New migration files since the running version, applied with the new image
  # before anything switches over. apply-migrations.js refuses destructive SQL.
  local NEW_MIGRATIONS
  NEW_MIGRATIONS=$(git -C "$APP" diff --name-only --diff-filter=A "$PREV" "$SHA" -- 'backend/src/db/migrations/*.sql' | xargs -r -n1 basename | sort | tr '\n' ' ')
  if [[ -n "${NEW_MIGRATIONS// /}" ]]; then
    log "applying migrations: $NEW_MIGRATIONS"
    if ! $COMPOSE run --rm --no-deps -T backend sh -c \
        "CONFIRM_TARGET=\$(node -e 'console.log(new URL(process.env.DATABASE_URL).host)') node scripts/apply-migrations.js $NEW_MIGRATIONS"; then
      log "migration failed: still running $(git -C "$APP" rev-parse --short "$PREV")"
      restore_checkout; exit 1
    fi
  fi

  # Keep the images that are running now as :previous, so a bad release rolls
  # back in seconds. (The build above has already moved :latest to the new ones.)
  local RUNNING_BACKEND RUNNING_DASHBOARD
  RUNNING_BACKEND=$(docker inspect -f '{{.Image}}' fwtracker-backend-1 2>/dev/null || true)
  RUNNING_DASHBOARD=$(docker inspect -f '{{.Image}}' fwtracker-dashboard-1 2>/dev/null || true)
  [[ -n "$RUNNING_BACKEND" ]] && docker image tag "$RUNNING_BACKEND" fwtracker-backend:previous
  [[ -n "$RUNNING_DASHBOARD" ]] && docker image tag "$RUNNING_DASHBOARD" fwtracker-dashboard:previous

  log "switching containers"
  $COMPOSE up -d --no-build

  log "health check"
  local ok=0
  for _ in $(seq 1 30); do
    if curl -fsS --max-time 5 http://127.0.0.1:4100/api/health >/dev/null \
       && curl -fsS --max-time 5 -o /dev/null http://127.0.0.1:3100/; then ok=1; break; fi
    sleep 3
  done

  if [[ "$ok" != 1 ]]; then
    log "UNHEALTHY: rolling back to $(git -C "$APP" rev-parse --short "$PREV")"
    $COMPOSE logs --tail 40 backend || true
    [[ -n "$RUNNING_BACKEND" ]] && docker image tag fwtracker-backend:previous fwtracker-backend:latest
    [[ -n "$RUNNING_DASHBOARD" ]] && docker image tag fwtracker-dashboard:previous fwtracker-dashboard:latest
    $COMPOSE up -d --no-build
    restore_checkout
    exit 1
  fi

  docker image prune -f >/dev/null 2>&1 || true
  # Self-update for next time: atomic replace, this run keeps the old inode.
  install -m 0755 "$APP/deploy/deploy.sh" /opt/fwtracker/bin/deploy.sh.new && mv -f /opt/fwtracker/bin/deploy.sh.new /opt/fwtracker/bin/deploy.sh
  log "deployed $(git -C "$APP" log -1 --format='%h %s')"
}

main "$@" 2>&1 | tee -a /opt/fwtracker/deploy.log
exit "${PIPESTATUS[0]}"
