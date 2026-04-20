#!/bin/bash
# Phase 3b: retrain MobileNet, complete cross-org eval for all models, re-run AL sim
# Run via SSM after instance is up: bash run_phase3b.sh
set -euo pipefail
LOG="/home/ubuntu/phase3b.log"
exec >"$LOG" 2>&1

BUCKET="peakme-ions"
REGION="us-west-1"
RESULTS="/home/ubuntu/research_results"
DATA="/home/ubuntu/research_data"
CACHE="/home/ubuntu/ion_cache"
SCRIPTS="/home/ubuntu/scripts"

echo "=== Phase 3b: MobileNet retrain + cross-org + AL sim ==="
date

echo "--- Installing deps ---"
pip3 install -q torch torchvision --index-url https://download.pytorch.org/whl/cpu
pip3 install -q scikit-learn boto3 pandas pillow matplotlib scipy

echo "--- Downloading scripts ---"
mkdir -p "$RESULTS" "$DATA" "$CACHE" "$SCRIPTS"
aws s3 sync "s3://$BUCKET/research/scripts/" "$SCRIPTS/" --region "$REGION"
# strip CRLF safely
for f in "$SCRIPTS"/*.py "$SCRIPTS"/*.sh; do
  tr -d '\r' < "$f" > "${f}.clean" && mv "${f}.clean" "$f"
done

echo "--- Downloading data + existing results ---"
aws s3 cp "s3://$BUCKET/research/annotations.csv" "$DATA/annotations.csv" --region "$REGION"
aws s3 sync "s3://$BUCKET/research/results/" "$RESULTS/" --region "$REGION" --exclude "*.pt"

echo "--- Downloading existing model weights (efnet + resnet50) ---"
aws s3 cp "s3://$BUCKET/research/results/model_efficientnet_b0.pt" "$RESULTS/model_efficientnet_b0.pt" --region "$REGION"
aws s3 cp "s3://$BUCKET/research/results/model_resnet50_offsample.pt" "$RESULTS/model_resnet50_offsample.pt" --region "$REGION"

echo "--- Step 1: Train MobileNet-V3-Small (10 epochs) ---"
python3 "$SCRIPTS/03_train_classifier.py" \
    --csv "$DATA/annotations.csv" \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --out "$RESULTS" \
    --cache-dir "$CACHE" \
    --epochs 10 \
    --batch-size 32 \
    --workers 4 \
    --models mobilenet_v3_small

echo "--- Uploading MobileNet weights to S3 ---"
aws s3 cp "$RESULTS/model_mobilenet_v3_small.pt" \
    "s3://$BUCKET/research/results/model_mobilenet_v3_small.pt" --region "$REGION"

echo "--- Step 2: Cross-org eval for EfficientNet + ResNet-50 ---"
python3 "$SCRIPTS/03_train_classifier.py" \
    --csv "$DATA/annotations.csv" \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --out "$RESULTS" \
    --cache-dir "$CACHE" \
    --epochs 10 \
    --batch-size 32 \
    --workers 4 \
    --cross-org-only

echo "--- Step 3: AL simulation with MobileNet ---"
python3 "$SCRIPTS/04_active_learning_sim.py" \
    --csv "$DATA/annotations.csv" \
    --model-path "$RESULTS/model_mobilenet_v3_small.pt" \
    --model-name mobilenet_v3_small \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --out "$RESULTS" \
    --cache-dir "$CACHE" \
    --batch-size 64 \
    --workers 4

echo "--- Uploading all results ---"
aws s3 sync "$RESULTS/" "s3://$BUCKET/research/results/" --region "$REGION" --exclude "*.pt"
aws s3 cp "$RESULTS/model_mobilenet_v3_small.pt" \
    "s3://$BUCKET/research/results/model_mobilenet_v3_small.pt" --region "$REGION"

echo "=== DONE ==="
date
