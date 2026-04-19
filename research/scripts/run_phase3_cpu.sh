#!/bin/bash
set -euo pipefail
LOG=/home/ubuntu/phase3_cpu.log
exec >"$LOG" 2>&1

BUCKET="peakme-ions"
REGION="us-west-1"
RESULTS_DIR="/home/ubuntu/research_results"
DATA_DIR="/home/ubuntu/research_data"
CACHE_DIR="/home/ubuntu/ion_cache"
PYTHON=python3
PIP=pip3

# GPU quota request IDs — checked after each model
QUOTA_G="f6ead070f62445759576d94d2a52c6456dBfJlSk"
QUOTA_P="20ad2b4e799343d4bbedcff0a0762db158Wy2nAG"

# Model order: fastest to slowest on CPU
MODELS=("mobilenet_v3_small" "resnet18" "efficientnet_b0" "resnet50_offsample")

echo "=== PeakMe Research — Phase 3 (CPU, incremental) ==="
date

echo "--- Installing deps ---"
$PIP install -q torch torchvision --index-url https://download.pytorch.org/whl/cpu
$PIP install -q scikit-learn boto3 pandas pillow matplotlib scipy

echo "--- Syncing scripts from S3 ---"
aws s3 sync "s3://$BUCKET/research/scripts/" /home/ubuntu/scripts/ --region "$REGION"
for f in /home/ubuntu/scripts/*.sh /home/ubuntu/scripts/*.py; do sed -i "s/\r//g" "$f"; done

echo "--- Downloading annotations CSV ---"
mkdir -p "$RESULTS_DIR" "$DATA_DIR" "$CACHE_DIR"
aws s3 cp "s3://$BUCKET/research/annotations.csv" "$DATA_DIR/annotations.csv" --region "$REGION"

echo "--- Syncing any existing results (resume support) ---"
aws s3 sync "s3://$BUCKET/research/results/" "$RESULTS_DIR/" --region "$REGION" --exclude "*.png"

check_gpu_quota() {
    G_STATUS=$(aws service-quotas get-requested-service-quota-change \
        --request-id "$QUOTA_G" --region "$REGION" \
        --query 'RequestedQuota.Status' --output text 2>/dev/null || echo "UNKNOWN")
    P_STATUS=$(aws service-quotas get-requested-service-quota-change \
        --request-id "$QUOTA_P" --region "$REGION" \
        --query 'RequestedQuota.Status' --output text 2>/dev/null || echo "UNKNOWN")
    echo "  Quota check — G-family: $G_STATUS | P-family: $P_STATUS"
    if [ "$G_STATUS" = "APPROVED" ] || [ "$P_STATUS" = "APPROVED" ]; then
        return 0
    fi
    return 1
}

for MODEL in "${MODELS[@]}"; do
    echo ""
    echo "=== Checking GPU quota before $MODEL ==="
    if check_gpu_quota; then
        echo "GPU QUOTA APPROVED — stopping CPU run. Re-run on GPU instance."
        aws s3 sync "$RESULTS_DIR/" "s3://$BUCKET/research/results/" --region "$REGION" --exclude "*.pt"
        echo "GPU_QUOTA_APPROVED" > "$RESULTS_DIR/phase3_status.txt"
        aws s3 cp "$RESULTS_DIR/phase3_status.txt" "s3://$BUCKET/research/results/phase3_status.txt" --region "$REGION"
        exit 0
    fi

    echo "=== Training: $MODEL ==="
    date
    $PYTHON /home/ubuntu/scripts/03_train_classifier.py \
        --csv "$DATA_DIR/annotations.csv" \
        --bucket "$BUCKET" \
        --region "$REGION" \
        --out "$RESULTS_DIR" \
        --cache-dir "$CACHE_DIR" \
        --epochs 10 \
        --batch-size 32 \
        --workers 4 \
        --models "$MODEL"
    date
    echo "--- Uploading results after $MODEL ---"
    aws s3 sync "$RESULTS_DIR/" "s3://$BUCKET/research/results/" --region "$REGION" --exclude "*.pt"
done

echo ""
echo "=== All 4 models complete on CPU — running cross-organism eval ==="
$PYTHON /home/ubuntu/scripts/03_train_classifier.py \
    --csv "$DATA_DIR/annotations.csv" \
    --bucket "$BUCKET" \
    --region "$REGION" \
    --out "$RESULTS_DIR" \
    --cache-dir "$CACHE_DIR" \
    --epochs 10 \
    --batch-size 32 \
    --workers 4 \
    --cross-org-only

echo "--- Final upload ---"
aws s3 sync "$RESULTS_DIR/" "s3://$BUCKET/research/results/" --region "$REGION" --exclude "*.pt"

echo "CPU_COMPLETE" > "$RESULTS_DIR/phase3_status.txt"
aws s3 cp "$RESULTS_DIR/phase3_status.txt" "s3://$BUCKET/research/results/phase3_status.txt" --region "$REGION"

echo "=== DONE phase 3 (CPU) ==="
date
