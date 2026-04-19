"""
Phase 2: Image Statistics Baseline (no ML)
Downloads a stratified sample of ion images from S3, extracts hand-crafted
features, trains a logistic regression + decision tree, and saves results.

Usage:
    python 02_image_statistics.py \
        --csv /path/to/annotations.csv \
        --bucket peakme-ions \
        --region us-west-1 \
        --sample-per-class 500 \
        --out /path/to/results/ \
        --workers 16
"""

import argparse
import json
import os
import pickle
import io
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import boto3
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from PIL import Image
from scipy import ndimage
from scipy.stats import entropy as scipy_entropy
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (classification_report, confusion_matrix,
                             roc_auc_score, f1_score)
from sklearn.model_selection import StratifiedKFold
from sklearn.preprocessing import StandardScaler
from sklearn.tree import DecisionTreeClassifier

LABEL_MAP = {
    "on tissue": "on_tissue",
    "On tissue": "on_tissue",
    "HP-associated": "on_tissue",
    "off tissue": "off_tissue",
    "Off tissue": "off_tissue",
    "Off-Tissue": "off_tissue",
    "unclear": "unclear",
    "Unclear": "unclear",
}

EXCLUDE_PROJECTS = {"test project", "new test", "65DNeoInfM3_10_test2"}


# ── Feature extraction ────────────────────────────────────────────────────────

def extract_features(img_array: np.ndarray) -> dict:
    """Extract hand-crafted spatial and intensity features from an ion image."""
    gray = img_array.mean(axis=2).astype(np.float32) / 255.0
    h, w = gray.shape

    # Basic intensity
    mean_intensity = float(gray.mean())
    std_intensity = float(gray.std())
    max_intensity = float(gray.max())

    # Foreground fraction (pixels above 10% of max)
    thresh = max_intensity * 0.1 if max_intensity > 0 else 0.1
    fg_fraction = float((gray > thresh).mean())

    # Histogram entropy (structuredness)
    hist, _ = np.histogram(gray, bins=32, range=(0, 1), density=True)
    hist_entropy = float(scipy_entropy(hist + 1e-10))

    # Spatial chaos (same idea as METASPACE): how structured is the spatial pattern?
    # Use coefficient of variation of a downsampled version
    small = gray[::4, ::4]
    spatial_cv = float(small.std() / (small.mean() + 1e-8))

    # Central vs peripheral intensity ratio
    cy, cx = h // 2, w // 2
    r = min(h, w) // 4
    inner_mask = np.zeros((h, w), dtype=bool)
    yy, xx = np.ogrid[:h, :w]
    inner_mask[(yy - cy) ** 2 + (xx - cx) ** 2 <= r ** 2] = True
    outer_mask = ~inner_mask
    center_mean = float(gray[inner_mask].mean()) if inner_mask.any() else 0.0
    outer_mean = float(gray[outer_mask].mean()) if outer_mask.any() else 0.0
    center_periphery_ratio = center_mean / (outer_mean + 1e-8)

    # Gradient magnitude mean (Sobel — measures spatial structure/edges)
    sobel_x = ndimage.sobel(gray, axis=0)
    sobel_y = ndimage.sobel(gray, axis=1)
    gradient_mean = float(np.sqrt(sobel_x ** 2 + sobel_y ** 2).mean())

    # Laplacian variance (sharpness)
    laplacian = ndimage.laplace(gray)
    laplacian_var = float(laplacian.var())

    # Quadrant variance (checks for scan-direction artefacts)
    q1 = gray[:h//2, :w//2].mean()
    q2 = gray[:h//2, w//2:].mean()
    q3 = gray[h//2:, :w//2].mean()
    q4 = gray[h//2:, w//2:].mean()
    quadrant_std = float(np.std([q1, q2, q3, q4]))

    # Horizontal vs vertical gradient (scan-direction artefact detection)
    horiz_grad = float(abs(sobel_x).mean())
    vert_grad = float(abs(sobel_y).mean())
    hv_ratio = horiz_grad / (vert_grad + 1e-8)

    return {
        "mean_intensity": mean_intensity,
        "std_intensity": std_intensity,
        "max_intensity": max_intensity,
        "fg_fraction": fg_fraction,
        "hist_entropy": hist_entropy,
        "spatial_cv": spatial_cv,
        "center_periphery_ratio": center_periphery_ratio,
        "gradient_mean": gradient_mean,
        "laplacian_var": laplacian_var,
        "quadrant_std": quadrant_std,
        "hv_ratio": hv_ratio,
    }


def load_image_from_s3(s3_client, bucket: str, key: str) -> np.ndarray | None:
    try:
        obj = s3_client.get_object(Bucket=bucket, Key=key)
        img = Image.open(io.BytesIO(obj["Body"].read())).convert("RGB")
        return np.array(img)
    except Exception as e:
        print(f"  WARN: failed to load {key}: {e}")
        return None


# ── Model training and evaluation ─────────────────────────────────────────────

def evaluate_model(X: np.ndarray, y: np.ndarray, model, name: str, cv=5) -> dict:
    skf = StratifiedKFold(n_splits=cv, shuffle=True, random_state=42)
    f1s, aucs = [], []
    for fold, (train_idx, val_idx) in enumerate(skf.split(X, y)):
        X_tr, X_val = X[train_idx], X[val_idx]
        y_tr, y_val = y[train_idx], y[val_idx]
        scaler = StandardScaler()
        X_tr = scaler.fit_transform(X_tr)
        X_val = scaler.transform(X_val)
        model.fit(X_tr, y_tr)
        y_pred = model.predict(X_val)
        y_prob = model.predict_proba(X_val)[:, 1] if hasattr(model, "predict_proba") else None
        f1s.append(f1_score(y_val, y_pred, pos_label="on_tissue"))
        if y_prob is not None:
            try:
                aucs.append(roc_auc_score(y_val, y_prob))
            except Exception:
                pass
    result = {
        "model": name,
        "f1_mean": round(float(np.mean(f1s)), 4),
        "f1_std": round(float(np.std(f1s)), 4),
        "f1_per_fold": [round(float(f), 4) for f in f1s],
    }
    if aucs:
        result["auc_mean"] = round(float(np.mean(aucs)), 4)
        result["auc_std"] = round(float(np.std(aucs)), 4)
    print(f"  {name}: F1={result['f1_mean']:.4f}±{result['f1_std']:.4f}", end="")
    if aucs:
        print(f"  AUC={result['auc_mean']:.4f}", end="")
    print()
    return result


# ── Plots ─────────────────────────────────────────────────────────────────────

def plot_feature_distributions(feat_df: pd.DataFrame, out_dir: Path) -> None:
    features = [c for c in feat_df.columns if c != "label"]
    n = len(features)
    fig, axes = plt.subplots(3, 4, figsize=(16, 10))
    axes = axes.flatten()
    colors = {"on_tissue": "#22c55e", "off_tissue": "#ef4444"}
    for i, feat in enumerate(features[:n]):
        ax = axes[i]
        for label, grp in feat_df.groupby("label"):
            if label in colors:
                ax.hist(grp[feat].dropna(), bins=40, alpha=0.5,
                        label=label, color=colors[label], density=True)
        ax.set_title(feat, fontsize=9)
        ax.set_xlabel("")
        if i == 0:
            ax.legend(fontsize=7)
    for j in range(n, len(axes)):
        axes[j].set_visible(False)
    plt.suptitle("Feature distributions by label (on_tissue vs off_tissue)", fontsize=11)
    plt.tight_layout()
    plt.savefig(out_dir / "02a_feature_distributions.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 02a_feature_distributions.png")


def plot_feature_importance(feat_df: pd.DataFrame, out_dir: Path) -> None:
    binary_df = feat_df[feat_df["label"].isin(["on_tissue", "off_tissue"])].copy()
    X = binary_df.drop(columns=["label"]).values
    y = binary_df["label"].values
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    lr = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)
    lr.fit(X_scaled, y)
    coefs = pd.Series(lr.coef_[0], index=binary_df.drop(columns=["label"]).columns)
    coefs_abs = coefs.abs().sort_values(ascending=True)
    fig, ax = plt.subplots(figsize=(8, 6))
    coefs_abs.plot(kind="barh", ax=ax, color="#3b82f6")
    ax.set_title("Logistic regression |coefficient| (feature importance proxy)")
    ax.set_xlabel("|coefficient|")
    plt.tight_layout()
    plt.savefig(out_dir / "02b_feature_importance.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 02b_feature_importance.png")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--bucket", default="peakme-ions")
    parser.add_argument("--region", default="us-west-1")
    parser.add_argument("--sample-per-class", type=int, default=500)
    parser.add_argument("--out", default="results")
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print("Loading CSV...")
    df = pd.read_csv(args.csv)
    df = df[~df["project_name"].isin(EXCLUDE_PROJECTS)].copy()
    df["label_norm"] = df["label_name"].map(LABEL_MAP)
    binary_df = df[df["label_norm"].isin(["on_tissue", "off_tissue"])].copy()

    # Stratified sample per class
    rng = np.random.default_rng(42)
    sample_rows = []
    for label, grp in binary_df.groupby("label_norm"):
        n = min(args.sample_per_class, len(grp))
        idx = rng.choice(len(grp), size=n, replace=False)
        sample_rows.append(grp.iloc[idx])
    sample_df = pd.concat(sample_rows).reset_index(drop=True)
    print(f"Sample: {sample_df['label_norm'].value_counts().to_dict()}")

    # Download images from S3 and extract features
    s3 = boto3.client("s3", region_name=args.region)
    features = []

    def process_row(row):
        img = load_image_from_s3(s3, args.bucket, row["image_key"])
        if img is None:
            return None
        feats = extract_features(img)
        feats["label"] = row["label_norm"]
        feats["project"] = row["project_name"]
        feats["dataset"] = row["dataset_name"]
        return feats

    print(f"Downloading and extracting features from {len(sample_df)} images "
          f"with {args.workers} workers...")
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process_row, row): i
                   for i, row in sample_df.iterrows()}
        done = 0
        for fut in as_completed(futures):
            result = fut.result()
            if result:
                features.append(result)
            done += 1
            if done % 100 == 0:
                print(f"  {done}/{len(sample_df)} images processed")

    feat_df = pd.DataFrame(features)
    feat_df.to_csv(out_dir / "02_image_features.csv", index=False)
    print(f"Features saved: {len(feat_df)} rows")

    # Plot feature distributions
    plot_feature_distributions(feat_df, out_dir)
    plot_feature_importance(feat_df, out_dir)

    # Train and evaluate models
    binary_feats = feat_df[feat_df["label"].isin(["on_tissue", "off_tissue"])].copy()
    feature_cols = [c for c in binary_feats.columns
                    if c not in ("label", "project", "dataset")]
    X = binary_feats[feature_cols].values
    y = binary_feats["label"].values

    print("\nTraining baseline models (5-fold CV)...")
    lr = LogisticRegression(max_iter=1000, class_weight="balanced", random_state=42)
    dt = DecisionTreeClassifier(max_depth=6, class_weight="balanced", random_state=42)
    lr_result = evaluate_model(X, y, lr, "LogisticRegression")
    dt_result = evaluate_model(X, y, dt, "DecisionTree(depth=6)")

    # Per-project breakdown
    per_project = {}
    for proj, grp in binary_feats.groupby("project"):
        Xp = grp[feature_cols].values
        yp = grp["label"].values
        if len(np.unique(yp)) < 2:
            continue
        scaler = StandardScaler()
        Xp = scaler.fit_transform(Xp)
        lr.fit(Xp, yp)
        y_pred = lr.predict(Xp)  # training accuracy (informative for per-project only)
        per_project[proj] = {
            "n": len(yp),
            "f1": round(float(f1_score(yp, y_pred, pos_label="on_tissue")), 4),
        }

    baseline_results = {
        "n_images": len(feat_df),
        "feature_names": feature_cols,
        "models": [lr_result, dt_result],
        "per_project_train_f1": per_project,
    }

    json_path = out_dir / "02_baseline_stats.json"
    with open(json_path, "w") as f:
        json.dump(baseline_results, f, indent=2)
    print(f"\nSaved: {json_path}")
    print(f"\nKey result: Logistic regression F1 = {lr_result['f1_mean']:.4f} "
          f"(baseline without any deep learning)")


if __name__ == "__main__":
    main()
