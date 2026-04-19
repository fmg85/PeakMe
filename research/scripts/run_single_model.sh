#!/bin/bash
# Usage: MODEL_NAME=resnet50_offsample bash run_single_model.sh
set -euo pipefail
MODEL_NAME="${MODEL_NAME:?MODEL_NAME env var required}"
LOG="/home/ubuntu/phase3_${MODEL_NAME}.log"
exec >"$LOG" 2>&1

BUCKET="peakme-ions"
REGION="us-west-1"
RESULTS_DIR="/home/ubuntu/research_results"
DATA_DIR="/home/ubuntu/research_data"
CACHE_DIR="/home/ubuntu/ion_cache"

echo "=== Phase 3: $MODEL_NAME ==="
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

echo "--- Syncing existing results ---"
aws s3 sync "s3://$BUCKET/research/results/" "$RESULTS_DIR/" --region "$REGION" --exclude "*.png" --exclude "*.pt"

echo "--- Training $MODEL_NAME ---"
python3 /home/ubuntu/scripts/03_train_classifier.py \
    --csv "$DATA_DIR/annotations.csv" \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --out "$RESULTS_DIR" \
    --cache-dir "$CACHE_DIR" \
    --epochs 10 \
    --batch-size 32 \
    --workers 4 \
    --models "$MODEL_NAME"

echo "--- Uploading results ---"
aws s3 sync "$RESULTS_DIR/" "s3://$BUCKET/research/results/" --region "$REGION" --exclude "*.pt"

echo "=== DONE: $MODEL_NAME ==="
date
