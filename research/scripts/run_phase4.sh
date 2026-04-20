#!/bin/bash
# Phase 4: Active Learning Simulation
# Usage: bash run_phase4.sh
# Runs on a single c5.2xlarge (or larger). Needs model_mobilenet_v3_small.pt in S3.
set -euo pipefail
LOG="/home/ubuntu/phase4.log"
exec >"$LOG" 2>&1

BUCKET="peakme-ions"
REGION="us-west-1"
RESULTS_DIR="/home/ubuntu/research_results"
DATA_DIR="/home/ubuntu/research_data"
CACHE_DIR="/home/ubuntu/ion_cache"
MODEL_NAME="mobilenet_v3_small"

echo "=== Phase 4: Active Learning Simulation ==="
date

echo "--- Installing deps ---"
pip3 install -q torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip3 install -q scikit-learn boto3 pandas pillow matplotlib scipy

echo "--- Syncing scripts ---"
mkdir -p "$RESULTS_DIR" "$DATA_DIR" "$CACHE_DIR"
aws s3 sync "s3://$BUCKET/research/scripts/" /home/ubuntu/scripts/ --region "$REGION"
for f in /home/ubuntu/scripts/*.py; do sed -i "s/\r//g" "$f"; done

echo "--- Downloading data ---"
aws s3 cp "s3://$BUCKET/research/annotations.csv" "$DATA_DIR/annotations.csv" --region "$REGION"

echo "--- Downloading model weights ---"
aws s3 cp "s3://$BUCKET/research/results/model_${MODEL_NAME}.pt" \
    "$RESULTS_DIR/model_${MODEL_NAME}.pt" --region "$REGION"

echo "--- Syncing existing results ---"
aws s3 sync "s3://$BUCKET/research/results/" "$RESULTS_DIR/" --region "$REGION" \
    --exclude "*.pt" --exclude "model_*"

echo "--- Running Phase 4 simulation ---"
python3 /home/ubuntu/scripts/04_active_learning_sim.py \
    --csv "$DATA_DIR/annotations.csv" \
    --model-path "$RESULTS_DIR/model_${MODEL_NAME}.pt" \
    --model-name "$MODEL_NAME" \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --out "$RESULTS_DIR" \
    --cache-dir "$CACHE_DIR" \
    --batch-size 64 \
    --workers 4

echo "--- Uploading results ---"
aws s3 sync "$RESULTS_DIR/" "s3://$BUCKET/research/results/" \
    --region "$REGION" --exclude "*.pt"

echo "=== DONE: Phase 4 ==="
date
