#!/usr/bin/env bash
# userdata.sh — First-boot setup for Spot R job instance.
#
# Injected env vars (prepended by launch.sh):
#   S3_BUCKET   Checkpoint/input S3 bucket name
#   SIZE        128 or 256 (GB RAM)
#   REPO_URL    Optional git URL to clone into /mnt/ebs-data/work/
#
# This script ends with a reboot to apply the KASLR change required for
# reliable hibernation on Ubuntu 22.04. After reboot, systemd services
# (spot-monitor) start automatically. The script does NOT re-run.
# Wait for /var/lib/userdata-complete before SSHing in.

set -euo pipefail
exec > >(tee /var/log/userdata.log) 2>&1

echo "[userdata] Starting at $(date -Iseconds)"
echo "[userdata] S3_BUCKET=${S3_BUCKET:-} SIZE=${SIZE:-128}"

# ── System packages ───────────────────────────────────────────────────────────
export DEBIAN_FRONTEND=noninteractive

echo "[userdata] Adding CRAN PPA..."
apt-get install -y --no-install-recommends software-properties-common dirmngr
wget -qO- https://cloud.r-project.org/bin/linux/ubuntu/marutter_pubkey.asc \
  | tee /etc/apt/trusted.gpg.d/cran_ubuntu_key.asc
add-apt-repository -y "deb https://cloud.r-project.org/bin/linux/ubuntu jammy-cran40/"

echo "[userdata] Installing system packages..."
apt-get update -q
apt-get install -y --no-install-recommends \
  r-base \
  r-base-dev \
  libcurl4-openssl-dev \
  libssl-dev \
  libxml2-dev \
  libfontconfig1-dev \
  libudunits2-dev \
  libharfbuzz-dev \
  libfribidi-dev \
  libfreetype6-dev \
  libpng-dev \
  libtiff5-dev \
  libjpeg-dev \
  awscli \
  jq \
  git \
  curl \
  ec2-hibinit-agent \
  linux-aws

echo "[userdata] R version: $(R --version | head -1)"

# ── Disable KASLR (required for reliable hibernation on Ubuntu 22.04) ─────────
# https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/hibernation-disable-kaslr.html
echo "[userdata] Disabling KASLR for hibernation..."
GRUB_CFG=/etc/default/grub.d/50-cloudimg-settings.cfg
if [[ -f "$GRUB_CFG" ]]; then
  # Add nokaslr if not already present
  if ! grep -q "nokaslr" "$GRUB_CFG"; then
    sed -i 's/GRUB_CMDLINE_LINUX_DEFAULT="\(.*\)"/GRUB_CMDLINE_LINUX_DEFAULT="\1 nokaslr"/' "$GRUB_CFG"
  fi
else
  # Fallback: create the file
  cat > "$GRUB_CFG" <<'EOF'
GRUB_CMDLINE_LINUX_DEFAULT="console=tty1 console=ttyS0 nvme_core.io_timeout=4294967295 nokaslr"
EOF
fi
update-grub
echo "[userdata] KASLR disabled"

# ── Enable hibernation agent ──────────────────────────────────────────────────
# ec2-hibinit-agent creates swap >= RAM on each boot, required for hibernation
systemctl enable hibinit-agent.service
echo "[userdata] hibinit-agent enabled"

# ── R packages ────────────────────────────────────────────────────────────────
echo "[userdata] Installing R packages (this takes ~15-20 minutes)..."

Rscript -e "
  options(repos = c(CRAN = 'https://cloud.r-project.org'), Ncpus = parallel::detectCores())

  pkgs <- c('data.table', 'aws.s3', 'httpgd', 'languageserver', 'BiocManager',
            'remotes', 'renv')
  install.packages(pkgs[!pkgs %in% installed.packages()[,'Package']])

  # Bioconductor packages
  if (!requireNamespace('Cardinal', quietly = TRUE) ||
      !requireNamespace('BiocParallel', quietly = TRUE)) {
    BiocManager::install(c('Cardinal', 'BiocParallel'), update = FALSE, ask = FALSE)
  }

  cat('Installed packages:\n')
  cat(paste0('  ', rownames(installed.packages())), sep = '\n')
"
echo "[userdata] R packages installed"

# ── Mount data EBS volume ─────────────────────────────────────────────────────
echo "[userdata] Setting up data EBS mount..."

# Wait for the device to appear (it is attached asynchronously by launch.sh)
for i in $(seq 1 30); do
  if [[ -b /dev/xvdf ]]; then
    DATA_DEV=/dev/xvdf
    break
  elif [[ -b /dev/nvme1n1 ]]; then
    DATA_DEV=/dev/nvme1n1
    break
  fi
  echo "  Waiting for data EBS device... (${i}/30)"
  sleep 10
done

if [[ -z "${DATA_DEV:-}" ]]; then
  echo "[userdata] WARNING: Data EBS device not found. Skipping mount." \
    "Job data will be on root volume — NOT recommended for large datasets."
  DATA_DEV=""
fi

if [[ -n "${DATA_DEV:-}" ]]; then
  # Format if no filesystem present
  if ! blkid "$DATA_DEV" | grep -q TYPE; then
    echo "  Formatting $DATA_DEV as ext4 (label: msi-data)..."
    mkfs.ext4 -L msi-data -m 0 "$DATA_DEV"
  else
    echo "  $DATA_DEV already formatted (reusing existing data)"
  fi

  # Mount
  mkdir -p /mnt/ebs-data
  mount "$DATA_DEV" /mnt/ebs-data

  # Persistent fstab entry
  LABEL=$(blkid -s LABEL -o value "$DATA_DEV" || echo "")
  if [[ -n "$LABEL" ]]; then
    FSTAB_ENTRY="LABEL=${LABEL}"
  else
    FSTAB_ENTRY="$DATA_DEV"
  fi
  if ! grep -q "/mnt/ebs-data" /etc/fstab; then
    echo "${FSTAB_ENTRY} /mnt/ebs-data ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2" \
      >> /etc/fstab
  fi
  echo "  Mounted $DATA_DEV at /mnt/ebs-data"
fi

# Create working directories
for dir in inputs outputs checkpoints logs work; do
  mkdir -p "/mnt/ebs-data/${dir}"
done
chown -R ubuntu:ubuntu /mnt/ebs-data
echo "[userdata] Directories created under /mnt/ebs-data/"

# ── Write environment file ────────────────────────────────────────────────────
cat > /etc/spot-job.env <<EOF
S3_BUCKET=${S3_BUCKET:-}
CHECKPOINT_DIR=/mnt/ebs-data/checkpoints
INPUT_DIR=/mnt/ebs-data/inputs
OUTPUT_DIR=/mnt/ebs-data/outputs
LOG_DIR=/mnt/ebs-data/logs
WORK_DIR=/mnt/ebs-data/work
EOF
echo "[userdata] /etc/spot-job.env written"

# ── Install spot-monitor ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# spot-monitor.sh may be in the same directory as this script, or inline below
if [[ -f "$SCRIPT_DIR/spot-monitor.sh" ]]; then
  cp "$SCRIPT_DIR/spot-monitor.sh" /usr/local/bin/spot-monitor.sh
else
  # Inline fallback — written directly here so userdata is self-contained
  cat > /usr/local/bin/spot-monitor.sh <<'MONITOR'
#!/usr/bin/env bash
set -euo pipefail
source /etc/spot-job.env

log() { echo "[$(date -Iseconds)] $*" | tee -a /var/log/spot-monitor.log; }
log "Spot monitor started (S3_BUCKET=${S3_BUCKET:-none})"

while true; do
  TOKEN=$(curl -sf -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 30" 2>/dev/null || true)
  if [[ -n "$TOKEN" ]]; then
    HTTP=$(curl -sf -o /dev/null -w "%{http_code}" \
      -H "X-aws-ec2-metadata-token: $TOKEN" \
      "http://169.254.169.254/latest/meta-data/spot/termination-time" 2>/dev/null \
      || echo "000")
    if [[ "$HTTP" == "200" ]]; then
      log "TERMINATION NOTICE received — syncing checkpoints to S3"
      if [[ -n "${S3_BUCKET:-}" ]]; then
        aws s3 sync "$CHECKPOINT_DIR" "s3://$S3_BUCKET/checkpoints/" --quiet \
          && log "S3 sync complete" \
          || log "WARNING: S3 sync failed (exit $?)"
      fi
      touch /tmp/.spot-terminate
      log "Flag /tmp/.spot-terminate written. Hibernation/stop will proceed."
      exit 0
    fi
  fi
  sleep 5
done
MONITOR
fi

chmod +x /usr/local/bin/spot-monitor.sh

# ── Systemd service for spot-monitor ─────────────────────────────────────────
cat > /etc/systemd/system/spot-monitor.service <<'EOF'
[Unit]
Description=Spot Termination Monitor
After=network.target

[Service]
EnvironmentFile=/etc/spot-job.env
ExecStart=/usr/local/bin/spot-monitor.sh
Restart=always
RestartSec=5
StandardOutput=append:/var/log/spot-monitor.log
StandardError=append:/var/log/spot-monitor.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable spot-monitor.service
echo "[userdata] spot-monitor.service enabled"

# ── Configure httpgd for VS Code R extension ──────────────────────────────────
# httpgd serves plots over HTTP — VS Code R extension auto-detects and shows them inline
cat >> /etc/R/Rprofile.site <<'EOF'

# Enable httpgd for remote plot viewing via VS Code R extension
# Plots are served on http://<instance-ip>:8888/live
if (interactive() && requireNamespace("httpgd", quietly = TRUE)) {
  options(device = function(...) httpgd::hgd(host = "0.0.0.0", port = 8888, ...))
}
EOF
echo "[userdata] httpgd configured in /etc/R/Rprofile.site"

# ── Clone repository (optional) ───────────────────────────────────────────────
if [[ -n "${REPO_URL:-}" ]]; then
  echo "[userdata] Cloning $REPO_URL..."
  git clone "$REPO_URL" /mnt/ebs-data/work/LargeMSIproc
  chown -R ubuntu:ubuntu /mnt/ebs-data/work/LargeMSIproc
  echo "[userdata] Repository cloned"
fi

# ── Mark completion ───────────────────────────────────────────────────────────
touch /var/lib/userdata-complete
echo "[userdata] Setup complete at $(date -Iseconds)"
echo "[userdata] Rebooting to apply KASLR change (required for hibernation)..."

# Reboot applies KASLR change; spot-monitor starts automatically via systemd on next boot
reboot
