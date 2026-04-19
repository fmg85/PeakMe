#!/bin/bash
# EC2 Setup and Research Pipeline Runner
# Run this script once after SSH-ing into a fresh g4dn.xlarge DLAMI instance.
# Assumes: IAM role with s3:GetObject/PutObject on peakme-ions bucket.
#
# Usage: bash ec2_setup_and_run.sh [phase]
#   phase: all | 0.6 | 1 | 2 | 3 | 4 | upload
#   default: all

set -e
PHASE="${1:-all}"
BUCKET="peakme-ions"
REGION="us-west-1"
RESULTS_DIR="/home/ubuntu/research_results"
DATA_DIR="/home/ubuntu/research_data"
CACHE_DIR="/home/ubuntu/ion_cache"
OFFSAMPLE_DIR="/home/ubuntu/offsample"
SCRIPTS_DIR="/home/ubuntu/PeakMe/research/scripts"

echo "=== PeakMe ML Research Pipeline ==="
echo "Phase: $PHASE | Region: $REGION | Bucket: $BUCKET"
echo ""

# ── System setup ─────────────────────────────────────────────────────────────
setup_system() {
    echo ">>> System setup..."
    sudo apt-get update -q && sudo apt-get install -y -q git unzip awscli
    # DLAMI already has conda + PyTorch — activate the PyTorch env
    source /opt/conda/etc/profile.d/conda.sh || true
    conda activate pytorch 2>/dev/null || true
    pip install -q \
        scikit-image scikit-learn \
        matplotlib seaborn \
        Pillow boto3 pandas \
        scipy tqdm
    echo "System setup done."
}

# ── Clone / pull repo ─────────────────────────────────────────────────────────
setup_repo() {
    echo ">>> Setting up repo..."
    if [ ! -d "/home/ubuntu/PeakMe" ]; then
        git clone https://github.com/fmg85/PeakMe /home/ubuntu/PeakMe  # adjust org if needed
    else
        git -C /home/ubuntu/PeakMe pull --ff-only
    fi
    mkdir -p "$RESULTS_DIR" "$DATA_DIR" "$CACHE_DIR"
}

# ── Phase 0.6: Download OffsampleAI dataset ───────────────────────────────────
run_phase_06() {
    echo ""
    echo ">>> Phase 0.6: Download OffsampleAI dataset..."
    mkdir -p "$OFFSAMPLE_DIR"
    if [ ! -d "$OFFSAMPLE_DIR/offsample" ]; then
        git clone https://github.com/metaspace2020/offsample "$OFFSAMPLE_DIR/offsample"
    fi
    # Check if they provide pretrained weights — download if available
    OFFSAMPLE_WEIGHTS=""
    if [ -f "$OFFSAMPLE_DIR/offsample/model/checkpoint.pth" ]; then
        OFFSAMPLE_WEIGHTS="$OFFSAMPLE_DIR/offsample/model/checkpoint.pth"
        echo "Found OffsampleAI pretrained weights: $OFFSAMPLE_WEIGHTS"
    else
        echo "NOTE: No pretrained weights file found in OffsampleAI repo."
        echo "      Will use ImageNet init for ResNet-50 comparison."
        echo "      Check repo README for weight download instructions."
    fi
    echo "OFFSAMPLE_WEIGHTS=$OFFSAMPLE_WEIGHTS" > /home/ubuntu/offsample_config.sh
    echo "Phase 0.6 done."
}

# ── Download annotations CSV ──────────────────────────────────────────────────
download_csv() {
    CSV_PATH="$DATA_DIR/annotations.csv"
    if [ ! -f "$CSV_PATH" ]; then
        echo ">>> Downloading annotations CSV..."
        aws s3 cp "s3://$BUCKET/research/annotations.csv" "$CSV_PATH" --region "$REGION"
        wc -l "$CSV_PATH"
    else
        echo ">>> CSV already downloaded: $CSV_PATH"
    fi
    echo "$CSV_PATH"
}

# ── Phase 1: Data Audit ───────────────────────────────────────────────────────
run_phase_1() {
    echo ""
    echo ">>> Phase 1: Data Audit..."
    CSV_PATH=$(download_csv)
    python "$SCRIPTS_DIR/01_data_audit.py" \
        --csv "$CSV_PATH" \
        --out "$RESULTS_DIR"
    echo "Phase 1 done."
}

# ── Phase 2: Image Statistics ─────────────────────────────────────────────────
run_phase_2() {
    echo ""
    echo ">>> Phase 2: Image Statistics Baseline..."
    CSV_PATH="$DATA_DIR/annotations.csv"
    python "$SCRIPTS_DIR/02_image_statistics.py" \
        --csv "$CSV_PATH" \
        --bucket "$BUCKET" \
        --region "$REGION" \
        --sample-per-class 500 \
        --out "$RESULTS_DIR" \
        --workers 16
    echo "Phase 2 done."
}

# ── Phase 3: Transfer Learning ────────────────────────────────────────────────
run_phase_3() {
    echo ""
    echo ">>> Phase 3: Transfer Learning (4 models)..."
    CSV_PATH="$DATA_DIR/annotations.csv"
    source /home/ubuntu/offsample_config.sh 2>/dev/null || OFFSAMPLE_WEIGHTS=""
    python "$SCRIPTS_DIR/03_train_classifier.py" \
        --csv "$CSV_PATH" \
        --bucket "$BUCKET" \
        --region "$REGION" \
        --out "$RESULTS_DIR" \
        --cache-dir "$CACHE_DIR" \
        --epochs 15 \
        --batch-size 64 \
        --workers 4 \
        ${OFFSAMPLE_WEIGHTS:+--offsample-weights "$OFFSAMPLE_WEIGHTS"}
    echo "Phase 3 done."
}

# ── Phase 4: Active Learning Simulation ──────────────────────────────────────
run_phase_4() {
    echo ""
    echo ">>> Phase 4: Active Learning Simulation..."
    CSV_PATH="$DATA_DIR/annotations.csv"
    # Use best model from Phase 3 (prefer OffsampleAI ResNet-50)
    MODEL_PATH="$RESULTS_DIR/model_resnet50_offsample.pt"
    MODEL_NAME="resnet50_offsample"
    if [ ! -f "$MODEL_PATH" ]; then
        MODEL_PATH="$RESULTS_DIR/model_resnet18.pt"
        MODEL_NAME="resnet18"
    fi
    python "$SCRIPTS_DIR/04_active_learning_sim.py" \
        --csv "$CSV_PATH" \
        --model-path "$MODEL_PATH" \
        --model-name "$MODEL_NAME" \
        --bucket "$BUCKET" \
        --region "$REGION" \
        --out "$RESULTS_DIR" \
        --cache-dir "$CACHE_DIR" \
        --batch-size 64 \
        --workers 4
    echo "Phase 4 done."
}

# ── Upload results to S3 ──────────────────────────────────────────────────────
upload_results() {
    echo ""
    echo ">>> Uploading results to S3..."
    aws s3 sync "$RESULTS_DIR/" "s3://$BUCKET/research/results/" \
        --region "$REGION" \
        --exclude "*.pt"   # skip large model files for now
    # Upload model files separately (larger, explicit)
    for f in "$RESULTS_DIR"/*.pt; do
        [ -f "$f" ] && aws s3 cp "$f" "s3://$BUCKET/research/models/$(basename $f)" \
            --region "$REGION" && echo "Uploaded: $(basename $f)"
    done
    echo "Results uploaded to s3://$BUCKET/research/results/"
}

# ── Entry point ───────────────────────────────────────────────────────────────
setup_system
setup_repo

case "$PHASE" in
    all)
        run_phase_06
        run_phase_1
        run_phase_2
        run_phase_3
        run_phase_4
        upload_results
        ;;
    0.6) run_phase_06 ;;
    1)   download_csv; run_phase_1 ;;
    2)   run_phase_2 ;;
    3)   run_phase_3 ;;
    4)   run_phase_4 ;;
    upload) upload_results ;;
    *)
        echo "Unknown phase: $PHASE"
        echo "Usage: $0 [all|0.6|1|2|3|4|upload]"
        exit 1
        ;;
esac

echo ""
echo "=== Pipeline complete for phase: $PHASE ==="
