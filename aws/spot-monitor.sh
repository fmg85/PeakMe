#!/usr/bin/env bash
# spot-monitor.sh — Spot termination watchdog daemon.
#
# Runs as a systemd service (spot-monitor.service). Polls the EC2 instance
# metadata endpoint every 5 seconds for a Spot termination notice.
#
# On termination notice (2-minute warning):
#   1. Syncs step-level checkpoints to S3 (belt+suspenders alongside hibernation)
#   2. Writes /tmp/.spot-terminate so R checks the flag between pipeline steps
#      (relevant for SIZE=256 stop-behavior instances where hibernation is unavailable)
#
# With SIZE=128 (hibernation): AWS hibernates the instance after this script syncs
# to S3. Cardinal resumes from the exact mid-execution point when capacity returns.
#
# With SIZE=256 (stop): R detects /tmp/.spot-terminate between pipeline steps and
# exits cleanly. The job resumes from the last .rds checkpoint on restart.
#
# Logs to: /var/log/spot-monitor.log

set -euo pipefail
source /etc/spot-job.env

METADATA_BASE="http://169.254.169.254"
TERMINATION_PATH="/latest/meta-data/spot/termination-time"
POLL_INTERVAL=5
LOG_FILE="/var/log/spot-monitor.log"

log() {
  echo "[$(date -Iseconds)] $*" | tee -a "$LOG_FILE"
}

get_imdsv2_token() {
  curl -sf -X PUT "${METADATA_BASE}/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 30" \
    --connect-timeout 2 \
    --max-time 5 \
    2>/dev/null || true
}

check_termination() {
  local token="$1"
  if [[ -z "$token" ]]; then
    echo "000"
    return
  fi
  curl -sf -o /dev/null -w "%{http_code}" \
    -H "X-aws-ec2-metadata-token: $token" \
    "${METADATA_BASE}${TERMINATION_PATH}" \
    --connect-timeout 2 \
    --max-time 5 \
    2>/dev/null || echo "000"
}

handle_termination() {
  log "TERMINATION NOTICE received"

  # Sync step-level .rds checkpoints to S3
  if [[ -n "${S3_BUCKET:-}" && -d "${CHECKPOINT_DIR:-}" ]]; then
    log "Syncing checkpoints to s3://$S3_BUCKET/checkpoints/ ..."
    aws s3 sync "$CHECKPOINT_DIR" "s3://$S3_BUCKET/checkpoints/" \
      --quiet \
      --no-progress \
      && log "S3 sync complete" \
      || log "WARNING: S3 sync failed (exit $?)"
  else
    log "Skipping S3 sync (S3_BUCKET or CHECKPOINT_DIR not set)"
  fi

  # Write flag file — R pipeline checks this between steps (stop-behavior fallback)
  touch /tmp/.spot-terminate
  log "Flag /tmp/.spot-terminate written"

  log "Hibernation or stop will proceed. This monitor is done."
}

# ── Main loop ─────────────────────────────────────────────────────────────────
log "Spot monitor started"
log "  CHECKPOINT_DIR=${CHECKPOINT_DIR:-not set}"
log "  S3_BUCKET=${S3_BUCKET:-not set}"
log "  Polling every ${POLL_INTERVAL}s"

while true; do
  TOKEN=$(get_imdsv2_token)
  HTTP=$(check_termination "$TOKEN")

  if [[ "$HTTP" == "200" ]]; then
    handle_termination
    exit 0
  fi

  sleep "$POLL_INTERVAL"
done
