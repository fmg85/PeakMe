#!/bin/bash
set -euo pipefail
LOG=/home/ubuntu/research_run.log
exec >"$LOG" 2>&1

BUCKET="peakme-ions"
REGION="us-west-1"
RESULTS_DIR="/home/ubuntu/research_results"
DATA_DIR="/home/ubuntu/research_data"

echo "=== PeakMe Research — Phases 1-2 ==="
date

echo "--- Activating conda env ---"
source /opt/conda/etc/profile.d/conda.sh
conda activate pytorch

echo "--- Installing deps ---"
pip install -q scikit-image scikit-learn scipy Pillow boto3 pandas matplotlib seaborn

echo "--- Cloning/updating repo ---"
if [ ! -d /home/ubuntu/PeakMe ]; then
    git clone https://github.com/fmg85/PeakMe /home/ubuntu/PeakMe
else
    git -C /home/ubuntu/PeakMe fetch origin main
    git -C /home/ubuntu/PeakMe reset --hard origin/main
fi

mkdir -p "$RESULTS_DIR" "$DATA_DIR"

echo "--- Downloading annotations CSV ---"
aws s3 cp "s3://$BUCKET/research/annotations.csv" "$DATA_DIR/annotations.csv" --region "$REGION"
echo "Rows: $(wc -l < "$DATA_DIR/annotations.csv")"

echo "--- Phase 1: Data Audit ---"
python /home/ubuntu/PeakMe/research/scripts/01_data_audit.py \
    --csv "$DATA_DIR/annotations.csv" \
    --out "$RESULTS_DIR"

echo "--- Phase 2: Image Statistics ---"
python /home/ubuntu/PeakMe/research/scripts/02_image_statistics.py \
    --csv "$DATA_DIR/annotations.csv" \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --sample-per-class 500 \
    --out "$RESULTS_DIR" \
    --workers 16

echo "--- Uploading results ---"
aws s3 sync "$RESULTS_DIR/" "s3://$BUCKET/research/results/" \
    --region "$REGION" \
    --exclude "*.pt"

echo "=== DONE phases 1-2 ==="
date
