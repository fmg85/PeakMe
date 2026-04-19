"""
Phase 3: Transfer Learning Classifier
Trains 4 model variants and evaluates cross-organism transfer.

Models:
  1. ResNet-50  with OffsampleAI pretrained weights  (closest prior work)
  2. EfficientNet-B0 with ImageNet weights
  3. ResNet-18  with ImageNet weights
  4. MobileNetV3-Small with ImageNet weights

Binary labels: on_tissue=1, off_tissue=0
Unclear ions: excluded from training, included in coverage analysis

Results saved to s3://peakme-ions/research/results/ and local out dir.

Usage:
    python 03_train_classifier.py \
        --csv /data/annotations.csv \
        --bucket peakme-ions \
        --region us-west-1 \
        --out /data/results/ \
        --epochs 15 \
        --batch-size 64 \
        --workers 8
"""

import argparse
import io
import json
import os
import time
from pathlib import Path

import boto3
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.optim as optim
from PIL import Image
from sklearn.calibration import calibration_curve
from sklearn.metrics import (classification_report, confusion_matrix,
                             f1_score, roc_auc_score)
from torch.utils.data import DataLoader, Dataset, WeightedRandomSampler
from torchvision import models, transforms
from torchvision.models import (EfficientNet_B0_Weights, MobileNet_V3_Small_Weights,
                                 ResNet18_Weights, ResNet50_Weights)

# ── Label setup ───────────────────────────────────────────────────────────────

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
BINARY_LABEL = {"on_tissue": 1, "off_tissue": 0}

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD = [0.229, 0.224, 0.225]


# ── Dataset ───────────────────────────────────────────────────────────────────

class IonImageDataset(Dataset):
    def __init__(self, df: pd.DataFrame, s3_client, bucket: str,
                 transform=None, cache_dir: str | None = None):
        self.df = df.reset_index(drop=True)
        self.s3 = s3_client
        self.bucket = bucket
        self.transform = transform
        self.cache_dir = Path(cache_dir) if cache_dir else None
        if self.cache_dir:
            self.cache_dir.mkdir(parents=True, exist_ok=True)

    def __len__(self):
        return len(self.df)

    def _load_image(self, key: str) -> Image.Image:
        if self.cache_dir:
            cache_path = self.cache_dir / key.replace("/", "_")
            if cache_path.exists():
                return Image.open(cache_path).convert("RGB")
        obj = self.s3.get_object(Bucket=self.bucket, Key=key)
        img = Image.open(io.BytesIO(obj["Body"].read())).convert("RGB")
        if self.cache_dir:
            img.save(cache_path)
        return img

    def __getitem__(self, idx):
        row = self.df.iloc[idx]
        try:
            img = self._load_image(row["image_key"])
        except Exception as e:
            img = Image.new("RGB", (224, 224), color=0)
        if self.transform:
            img = self.transform(img)
        label = BINARY_LABEL.get(row["label_norm"], -1)
        return img, label, row["ion_id"]


# ── Model builders ────────────────────────────────────────────────────────────

def build_model(name: str, offsample_weights_path: str | None = None) -> nn.Module:
    if name == "resnet50_offsample":
        model = models.resnet50(weights=ResNet50_Weights.IMAGENET1K_V1)
        model.fc = nn.Linear(model.fc.in_features, 2)
        if offsample_weights_path and os.path.exists(offsample_weights_path):
            print(f"  Loading OffsampleAI weights from {offsample_weights_path}")
            state = torch.load(offsample_weights_path, map_location="cpu")
            # OffsampleAI uses a 2-class head — load backbone only if head dims differ
            try:
                model.load_state_dict(state, strict=False)
                print("  Loaded OffsampleAI weights (strict=False)")
            except Exception as e:
                print(f"  WARN: could not load full state dict: {e}")
        return model

    elif name == "resnet50_imagenet":
        model = models.resnet50(weights=ResNet50_Weights.IMAGENET1K_V1)
        model.fc = nn.Linear(model.fc.in_features, 2)
        return model

    elif name == "efficientnet_b0":
        model = models.efficientnet_b0(weights=EfficientNet_B0_Weights.IMAGENET1K_V1)
        model.classifier[1] = nn.Linear(model.classifier[1].in_features, 2)
        return model

    elif name == "resnet18":
        model = models.resnet18(weights=ResNet18_Weights.IMAGENET1K_V1)
        model.fc = nn.Linear(model.fc.in_features, 2)
        return model

    elif name == "mobilenet_v3_small":
        model = models.mobilenet_v3_small(weights=MobileNet_V3_Small_Weights.IMAGENET1K_V1)
        model.classifier[3] = nn.Linear(model.classifier[3].in_features, 2)
        return model

    raise ValueError(f"Unknown model: {name}")


def freeze_backbone(model: nn.Module, name: str) -> None:
    """Freeze all layers except the final classifier."""
    if "resnet" in name:
        for param in model.parameters():
            param.requires_grad = False
        for param in model.fc.parameters():
            param.requires_grad = True
    elif "efficientnet" in name:
        for param in model.parameters():
            param.requires_grad = False
        for param in model.classifier.parameters():
            param.requires_grad = True
    elif "mobilenet" in name:
        for param in model.parameters():
            param.requires_grad = False
        for param in model.classifier.parameters():
            param.requires_grad = True


def unfreeze_backbone(model: nn.Module) -> None:
    for param in model.parameters():
        param.requires_grad = True


# ── Training ──────────────────────────────────────────────────────────────────

def train_epoch(model, loader, optimizer, criterion, device, freeze_epoch: int,
                current_epoch: int) -> float:
    if current_epoch == freeze_epoch:
        unfreeze_backbone(model)
        print("  Backbone unfrozen")
    model.train()
    total_loss = 0.0
    for imgs, labels, _ in loader:
        imgs, labels = imgs.to(device), labels.to(device)
        optimizer.zero_grad()
        logits = model(imgs)
        loss = criterion(logits, labels)
        loss.backward()
        optimizer.step()
        total_loss += loss.item() * len(imgs)
    return total_loss / len(loader.dataset)


@torch.no_grad()
def evaluate(model, loader, device, threshold: float = 0.5) -> dict:
    model.eval()
    all_preds, all_probs, all_labels, all_ids = [], [], [], []
    for imgs, labels, ids in loader:
        imgs = imgs.to(device)
        logits = model(imgs)
        probs = torch.softmax(logits, dim=1)[:, 1].cpu().numpy()
        preds = (probs >= threshold).astype(int)
        all_probs.extend(probs.tolist())
        all_preds.extend(preds.tolist())
        all_labels.extend(labels.numpy().tolist())
        all_ids.extend(list(ids))

    y_true = np.array(all_labels)
    y_pred = np.array(all_preds)
    y_prob = np.array(all_probs)

    valid = y_true >= 0
    y_true, y_pred, y_prob = y_true[valid], y_pred[valid], y_prob[valid]

    f1 = float(f1_score(y_true, y_pred, pos_label=1, zero_division=0))
    try:
        auc = float(roc_auc_score(y_true, y_prob))
    except Exception:
        auc = float("nan")

    # Coverage at confidence threshold (max probability > threshold)
    max_probs = np.maximum(y_prob, 1 - y_prob)
    for theta in [0.6, 0.7, 0.8, 0.9]:
        covered = (max_probs >= theta).mean()

    coverage = {f"coverage_at_{int(t*100)}": round(float((max_probs >= t).mean()), 4)
                for t in [0.6, 0.7, 0.8, 0.9]}

    return {
        "f1": round(f1, 4),
        "auc": round(auc, 4) if not np.isnan(auc) else None,
        "n": int(valid.sum()),
        "confusion_matrix": confusion_matrix(y_true, y_pred).tolist(),
        **coverage,
        "_probs": y_prob.tolist(),
        "_labels": y_true.tolist(),
    }


def train_model(model_name: str, train_df: pd.DataFrame, val_df: pd.DataFrame,
                test_df: pd.DataFrame, s3_client, bucket: str, args,
                device, cache_dir: str, offsample_path: str | None) -> dict:
    print(f"\n{'='*60}")
    print(f"Training: {model_name}")
    print(f"  Train: {len(train_df)}, Val: {len(val_df)}, Test: {len(test_df)}")

    train_transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.RandomHorizontalFlip(),
        transforms.RandomVerticalFlip(),
        transforms.RandomRotation(15),
        transforms.ColorJitter(brightness=0.2, contrast=0.2),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])
    val_transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])

    train_ds = IonImageDataset(train_df, s3_client, bucket, train_transform, cache_dir)
    val_ds = IonImageDataset(val_df, s3_client, bucket, val_transform, cache_dir)
    test_ds = IonImageDataset(test_df, s3_client, bucket, val_transform, cache_dir)

    # Weighted sampler to handle class imbalance
    labels_arr = train_df["label_norm"].map(BINARY_LABEL).values
    class_counts = np.bincount(labels_arr)
    weights = 1.0 / class_counts[labels_arr]
    sampler = WeightedRandomSampler(weights, len(weights), replacement=True)

    train_loader = DataLoader(train_ds, batch_size=args.batch_size, sampler=sampler,
                              num_workers=args.workers, pin_memory=True)
    val_loader = DataLoader(val_ds, batch_size=args.batch_size, shuffle=False,
                            num_workers=args.workers, pin_memory=True)
    test_loader = DataLoader(test_ds, batch_size=args.batch_size, shuffle=False,
                             num_workers=args.workers, pin_memory=True)

    model = build_model(model_name, offsample_path)
    freeze_backbone(model, model_name)
    model = model.to(device)

    # Class-weighted loss
    class_weight = torch.tensor([1.0 / class_counts[0], 1.0 / class_counts[1]],
                                  dtype=torch.float32).to(device)
    class_weight = class_weight / class_weight.sum()
    criterion = nn.CrossEntropyLoss(weight=class_weight)

    optimizer = optim.AdamW(filter(lambda p: p.requires_grad, model.parameters()),
                            lr=1e-3, weight_decay=1e-4)
    scheduler = optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)

    unfreeze_epoch = 3
    best_val_f1, best_state = 0.0, None
    history = {"train_loss": [], "val_f1": [], "val_auc": []}

    for epoch in range(args.epochs):
        t0 = time.time()
        train_loss = train_epoch(model, train_loader, optimizer, criterion,
                                 device, unfreeze_epoch, epoch)
        val_metrics = evaluate(model, val_loader, device)
        scheduler.step()

        history["train_loss"].append(round(train_loss, 4))
        history["val_f1"].append(val_metrics["f1"])
        history["val_auc"].append(val_metrics["auc"])

        if val_metrics["f1"] > best_val_f1:
            best_val_f1 = val_metrics["f1"]
            best_state = {k: v.cpu().clone() for k, v in model.state_dict().items()}

        print(f"  Epoch {epoch+1:2d}/{args.epochs} | loss={train_loss:.4f} "
              f"val_f1={val_metrics['f1']:.4f} val_auc={val_metrics['auc']} "
              f"({time.time()-t0:.1f}s)")

    # Load best weights and evaluate on test set
    model.load_state_dict(best_state)
    test_metrics = evaluate(model, test_loader, device)
    probs = test_metrics.pop("_probs")
    labels = test_metrics.pop("_labels")

    # Save model weights
    out_path = Path(args.out) / f"model_{model_name}.pt"
    torch.save(best_state, out_path)
    print(f"  Saved model: {out_path}")
    print(f"  TEST: F1={test_metrics['f1']:.4f} AUC={test_metrics['auc']}")

    return {
        "model_name": model_name,
        "best_val_f1": round(best_val_f1, 4),
        "test_metrics": test_metrics,
        "history": history,
        "model_path": str(out_path),
        "_probs": probs,
        "_labels": labels,
    }


# ── Cross-organism evaluation ─────────────────────────────────────────────────

def eval_cross_organism(model_name: str, model_path: str, test_df: pd.DataFrame,
                         s3_client, bucket: str, args, device: torch.device,
                         cache_dir: str, offsample_path: str | None) -> dict:
    print(f"  Cross-organism eval for {model_name}...")
    val_transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])
    ds = IonImageDataset(test_df, s3_client, bucket, val_transform, cache_dir)
    loader = DataLoader(ds, batch_size=args.batch_size, shuffle=False,
                        num_workers=args.workers, pin_memory=True)
    model = build_model(model_name, offsample_path)
    model.load_state_dict(torch.load(model_path, map_location=device))
    model = model.to(device)
    metrics = evaluate(model, loader, device)
    metrics.pop("_probs", None)
    metrics.pop("_labels", None)
    return metrics


# ── Calibration plot ─────────────────────────────────────────────────────────

def plot_calibration(results: list[dict], out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(8, 6))
    ax.plot([0, 1], [0, 1], "k--", label="Perfect calibration")
    for r in results:
        probs = np.array(r["_probs"])
        labels = np.array(r["_labels"])
        frac_pos, mean_pred = calibration_curve(labels, probs, n_bins=10)
        ax.plot(mean_pred, frac_pos, marker="o", label=r["model_name"])
    ax.set_xlabel("Mean predicted probability")
    ax.set_ylabel("Fraction of positives")
    ax.set_title("Calibration curves (test set)")
    ax.legend(fontsize=9)
    plt.tight_layout()
    plt.savefig(out_dir / "03a_calibration_curves.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 03a_calibration_curves.png")


def plot_training_curves(results: list[dict], out_dir: Path) -> None:
    fig, axes = plt.subplots(1, 2, figsize=(12, 5))
    for r in results:
        axes[0].plot(r["history"]["train_loss"], label=r["model_name"])
        axes[1].plot(r["history"]["val_f1"], label=r["model_name"])
    axes[0].set_title("Training loss")
    axes[0].set_xlabel("Epoch")
    axes[0].legend(fontsize=8)
    axes[1].set_title("Validation F1")
    axes[1].set_xlabel("Epoch")
    axes[1].legend(fontsize=8)
    plt.tight_layout()
    plt.savefig(out_dir / "03b_training_curves.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 03b_training_curves.png")


# ── Incremental save ─────────────────────────────────────────────────────────

def _save_results(all_results: list, cross_org: dict, out_dir: Path) -> None:
    stripped = []
    for r in all_results:
        rc = dict(r)
        rc.pop("_probs", None)
        rc.pop("_labels", None)
        stripped.append(rc)
        # Per-model file — safe for parallel instances (no shared write conflict)
        with open(out_dir / f"03_metrics_{rc['model_name']}.json", "w") as f:
            json.dump({**rc, "cross_organism": cross_org.get(rc["model_name"])}, f, indent=2)

    # Rebuild combined from all per-model files on disk (picks up parallel results)
    all_on_disk = {}
    for p in sorted(out_dir.glob("03_metrics_*.json")):
        with open(p) as f:
            d = json.load(f)
        all_on_disk[d["model_name"]] = d

    summary = []
    for r in all_on_disk.values():
        summary.append({
            "model": r["model_name"],
            "val_f1": r["best_val_f1"],
            "test_f1_human": r["test_metrics"]["f1"],
            "test_auc_human": r["test_metrics"]["auc"],
            "test_f1_mouse": (r.get("cross_organism") or {}).get("f1"),
            "coverage_70pct": r["test_metrics"].get("coverage_at_70"),
        })

    payload = {
        "models_complete": list(all_on_disk.keys()),
        "model_results": list(all_on_disk.values()),
        "cross_organism": cross_org,
        "summary": summary,
    }
    with open(out_dir / "03_model_metrics.json", "w") as f:
        json.dump(payload, f, indent=2)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--bucket", default="peakme-ions")
    parser.add_argument("--region", default="us-west-1")
    parser.add_argument("--out", default="results")
    parser.add_argument("--cache-dir", default="/tmp/ion_cache")
    parser.add_argument("--epochs", type=int, default=15)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--offsample-weights", default=None,
                        help="Path to OffsampleAI checkpoint .pth file")
    parser.add_argument("--models", default=None,
                        help="Comma-separated list of models to run (default: all 4). "
                             "Choices: resnet50_offsample,efficientnet_b0,resnet18,mobilenet_v3_small")
    parser.add_argument("--cross-org-only", action="store_true",
                        help="Only run cross-organism eval (skip training)")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    print("Loading CSV...")
    df = pd.read_csv(args.csv)
    df = df[~df["project_name"].isin(EXCLUDE_PROJECTS)].copy()
    df["label_norm"] = df["label_name"].map(LABEL_MAP)

    # Training data: binary labels only, exclude unclear
    binary_df = df[df["label_norm"].isin(["on_tissue", "off_tissue"])].copy()
    print(f"Binary training set: {binary_df['label_norm'].value_counts().to_dict()}")

    # Split: stratify by label AND project (to avoid leakage)
    # Hold out mouse project entirely as cross-organism test
    human_project = "GCPL"
    mouse_projects = [p for p in binary_df["project_name"].unique() if p != human_project]

    human_df = binary_df[binary_df["project_name"] == human_project].copy()
    mouse_df = binary_df[binary_df["project_name"].isin(mouse_projects)].copy()

    # Human: 70/15/15 train/val/test split per dataset (stratified by label)
    from sklearn.model_selection import train_test_split
    train_parts, val_parts, test_parts = [], [], []
    for ds, grp in human_df.groupby("dataset_name"):
        if len(grp) < 10:
            continue
        tmp_train, tmp_test = train_test_split(
            grp, test_size=0.30, stratify=grp["label_norm"], random_state=42)
        tmp_val, tmp_test = train_test_split(
            tmp_test, test_size=0.50, stratify=tmp_test["label_norm"], random_state=42)
        train_parts.append(tmp_train)
        val_parts.append(tmp_val)
        test_parts.append(tmp_test)

    train_df = pd.concat(train_parts)
    val_df = pd.concat(val_parts)
    test_human_df = pd.concat(test_parts)
    test_mouse_df = mouse_df  # entire mouse dataset = cross-organism test

    print(f"\nSplits (human): train={len(train_df)}, val={len(val_df)}, "
          f"test_human={len(test_human_df)}, test_mouse={len(test_mouse_df)}")

    s3 = boto3.client("s3", region_name=args.region)

    ALL_MODELS = [
        "resnet50_offsample",
        "efficientnet_b0",
        "resnet18",
        "mobilenet_v3_small",
    ]
    MODEL_NAMES = [m.strip() for m in args.models.split(",")] if args.models else ALL_MODELS

    # Load any previously completed model results (for incremental runs)
    json_path = out_dir / "03_model_metrics.json"
    existing = {}
    if json_path.exists():
        with open(json_path) as f:
            prev = json.load(f)
        for r in prev.get("model_results", []):
            existing[r["model_name"]] = r
        print(f"Loaded {len(existing)} previously completed model(s): {list(existing.keys())}")

    all_results = list(existing.values())

    if args.cross_org_only:
        MODEL_NAMES = []  # skip training loop entirely

    for model_name in MODEL_NAMES:
        if model_name in existing:
            print(f"Skipping {model_name} — already in results")
            continue
        result = train_model(
            model_name, train_df, val_df, test_human_df,
            s3, args.bucket, args, device, args.cache_dir,
            args.offsample_weights
        )
        all_results.append(result)

        # Save incremental results after each model (shell script checks for completion)
        _save_results(all_results, {}, out_dir)
        print(f"  Checkpoint saved after {model_name}")

    # Cross-organism evaluation (train on human → test on mouse)
    print("\n=== Cross-Organism Transfer (human → mouse) ===")
    cross_org_results = {}
    for r in all_results:
        metrics = eval_cross_organism(
            r["model_name"], r["model_path"], test_mouse_df,
            s3, args.bucket, args, device, args.cache_dir, args.offsample_weights
        )
        cross_org_results[r["model_name"]] = metrics
        print(f"  {r['model_name']}: F1={metrics['f1']:.4f} AUC={metrics['auc']}")

    # Plots
    plot_calibration(all_results, out_dir)
    plot_training_curves(all_results, out_dir)

    # Summary table
    summary = []
    for r in all_results:
        summary.append({
            "model": r["model_name"],
            "val_f1": r["best_val_f1"],
            "test_f1_human": r["test_metrics"]["f1"],
            "test_auc_human": r["test_metrics"]["auc"],
            "test_f1_mouse": cross_org_results[r["model_name"]]["f1"],
            "coverage_70pct": r["test_metrics"].get("coverage_at_70"),
        })

    print("\n=== Model Comparison ===")
    summary = []
    for r in all_results:
        summary.append({
            "model": r["model_name"],
            "val_f1": r["best_val_f1"],
            "test_f1_human": r["test_metrics"]["f1"],
            "test_auc_human": r["test_metrics"]["auc"],
            "test_f1_mouse": cross_org_results.get(r["model_name"], {}).get("f1"),
            "coverage_70pct": r["test_metrics"].get("coverage_at_70"),
        })
    print(pd.DataFrame(summary).to_string(index=False))

    _save_results(all_results, cross_org_results, out_dir)
    print(f"\nSaved: {out_dir / '03_model_metrics.json'}")


if __name__ == "__main__":
    main()
