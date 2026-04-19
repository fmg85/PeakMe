"""
Phase 4: Active Learning Simulation
Simulates the "annotate N, train, rank remaining" workflow using the
fully-annotated human dataset as ground truth.

Tests seed sizes N = 10, 100, 500, 1000, 2000, 5000
Compares:
  - Random ordering (current PeakMe behaviour)
  - Coreset sampling (diverse seed, then uncertainty)
  - Uncertainty sampling (entropy-based)

Each condition: 5 bootstrap replicates with different random seeds.
Best model from Phase 3 used for inference.

Usage:
    python 04_active_learning_sim.py \
        --csv /data/annotations.csv \
        --model-path /data/results/model_resnet50_offsample.pt \
        --model-name resnet50_offsample \
        --bucket peakme-ions \
        --region us-west-1 \
        --out /data/results/ \
        --workers 4
"""

import argparse
import io
import json
from pathlib import Path

import boto3
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from PIL import Image
from sklearn.metrics import f1_score
from torch.utils.data import DataLoader, Dataset
from torchvision import models, transforms
from torchvision.models import (EfficientNet_B0_Weights, MobileNet_V3_Small_Weights,
                                 ResNet18_Weights, ResNet50_Weights)

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

SEED_SIZES = [10, 100, 500, 1000, 2000, 5000]
N_REPLICATES = 5
QUERY_BATCH = 100   # annotate this many per AL round


# ── Simple inference dataset ──────────────────────────────────────────────────

class InferenceDataset(Dataset):
    def __init__(self, image_keys: list[str], s3_client, bucket: str,
                 transform, cache_dir: Path | None = None):
        self.keys = image_keys
        self.s3 = s3_client
        self.bucket = bucket
        self.transform = transform
        self.cache_dir = cache_dir

    def __len__(self):
        return len(self.keys)

    def __getitem__(self, idx):
        key = self.keys[idx]
        try:
            cache_path = self.cache_dir / key.replace("/", "_") if self.cache_dir else None
            if cache_path and cache_path.exists():
                img = Image.open(cache_path).convert("RGB")
            else:
                obj = self.s3.get_object(Bucket=self.bucket, Key=key)
                img = Image.open(io.BytesIO(obj["Body"].read())).convert("RGB")
                if cache_path:
                    img.save(cache_path)
        except Exception:
            img = Image.new("RGB", (224, 224), color=0)
        return self.transform(img), idx


# ── Model loading ─────────────────────────────────────────────────────────────

def load_model(name: str, path: str, device: torch.device) -> nn.Module:
    if "resnet50" in name:
        m = models.resnet50(weights=None)
        m.fc = nn.Linear(m.fc.in_features, 2)
    elif "efficientnet_b0" in name:
        m = models.efficientnet_b0(weights=None)
        m.classifier[1] = nn.Linear(m.classifier[1].in_features, 2)
    elif "resnet18" in name:
        m = models.resnet18(weights=None)
        m.fc = nn.Linear(m.fc.in_features, 2)
    elif "mobilenet" in name:
        m = models.mobilenet_v3_small(weights=None)
        m.classifier[3] = nn.Linear(m.classifier[3].in_features, 2)
    else:
        raise ValueError(f"Unknown model name: {name}")
    m.load_state_dict(torch.load(path, map_location=device))
    m.eval()
    return m.to(device)


# ── Inference: get probability scores ────────────────────────────────────────

@torch.no_grad()
def score_images(model: nn.Module, image_keys: list[str], s3_client, bucket: str,
                 device: torch.device, batch_size: int, workers: int,
                 cache_dir: Path | None) -> np.ndarray:
    transform = transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])
    ds = InferenceDataset(image_keys, s3_client, bucket, transform, cache_dir)
    loader = DataLoader(ds, batch_size=batch_size, shuffle=False, num_workers=workers)
    probs = np.zeros(len(image_keys))
    for imgs, idxs in loader:
        imgs = imgs.to(device)
        logits = model(imgs)
        p = torch.softmax(logits, dim=1)[:, 1].cpu().numpy()
        for i, idx in enumerate(idxs):
            probs[idx] = p[i]
    return probs


# ── Coreset sampling (greedy k-center) ───────────────────────────────────────

def coreset_select(features: np.ndarray, n: int, rng: np.random.Generator) -> list[int]:
    """Greedy k-center coreset: maximally diverse selection."""
    selected = [int(rng.integers(len(features)))]
    min_dists = np.full(len(features), np.inf)
    for _ in range(n - 1):
        last = features[selected[-1]]
        dists = np.sum((features - last) ** 2, axis=1)
        min_dists = np.minimum(min_dists, dists)
        min_dists[selected] = -np.inf
        selected.append(int(np.argmax(min_dists)))
    return selected


# ── AL simulation ─────────────────────────────────────────────────────────────

def simulate_al(df: pd.DataFrame, model: nn.Module, s3_client, bucket: str,
                device: torch.device, args, cache_dir: Path,
                seed_size: int, strategy: str, rng_seed: int) -> dict:
    """
    Simulate one AL run.
    Returns: discovery curve as list of (n_annotated, n_on_tissue_found).
    """
    rng = np.random.default_rng(rng_seed)
    all_idx = np.arange(len(df))
    on_tissue_total = int((df["label_norm"] == "on_tissue").sum())

    if strategy == "random":
        # Current PeakMe: shuffle order, present sequentially
        order = rng.permutation(all_idx)
        curve = []
        on_found = 0
        for step, i in enumerate(order):
            if df.iloc[i]["label_norm"] == "on_tissue":
                on_found += 1
            curve.append({"n_annotated": step + 1, "n_on_tissue": on_found,
                           "pct_on_tissue": round(on_found / on_tissue_total * 100, 2)})
        return {"curve": curve, "on_tissue_total": on_tissue_total}

    # AL strategies: start with seed, then iterative
    annotated_mask = np.zeros(len(df), dtype=bool)
    on_found = 0
    curve = []

    # Phase 1: seed selection
    if strategy == "coreset":
        # Use image keys as proxy features (sorted by m/z gives a rough spectrum of m/z diversity)
        # Better: use softmax probs from pretrained model as 1D feature
        seed_probs = score_images(model, df["image_key"].tolist(), s3_client, bucket,
                                  device, args.batch_size, args.workers, cache_dir)
        feat = seed_probs.reshape(-1, 1)
        seed_idx = coreset_select(feat, seed_size, rng)
    else:
        # Uncertainty sampling: start with random seed
        seed_idx = rng.choice(all_idx, size=seed_size, replace=False).tolist()

    for i in seed_idx:
        annotated_mask[i] = True
        if df.iloc[i]["label_norm"] == "on_tissue":
            on_found += 1
    curve.append({"n_annotated": int(annotated_mask.sum()),
                  "n_on_tissue": on_found,
                  "pct_on_tissue": round(on_found / on_tissue_total * 100, 2)})

    # Phase 2: iterative AL (uncertainty sampling)
    unannotated_idx = np.where(~annotated_mask)[0]
    rounds = 0
    max_rounds = 200  # safety limit

    while len(unannotated_idx) > 0 and rounds < max_rounds:
        # Score unannotated images
        unannotated_keys = df.iloc[unannotated_idx]["image_key"].tolist()
        probs = score_images(model, unannotated_keys, s3_client, bucket,
                             device, args.batch_size, args.workers, cache_dir)

        # Uncertainty = entropy of [p, 1-p]
        entropy = -(probs * np.log(probs + 1e-8) + (1 - probs) * np.log(1 - probs + 1e-8))
        query_n = min(QUERY_BATCH, len(unannotated_idx))
        top_uncertain = np.argsort(entropy)[-query_n:]
        selected_global = unannotated_idx[top_uncertain]

        for i in selected_global:
            annotated_mask[i] = True
            if df.iloc[i]["label_norm"] == "on_tissue":
                on_found += 1

        curve.append({"n_annotated": int(annotated_mask.sum()),
                      "n_on_tissue": on_found,
                      "pct_on_tissue": round(on_found / on_tissue_total * 100, 2)})

        unannotated_idx = np.where(~annotated_mask)[0]
        rounds += 1

    return {"curve": curve, "on_tissue_total": on_tissue_total}


# ── Aggregate + plot ──────────────────────────────────────────────────────────

def find_n_to_reach(curve: list[dict], target_pct: float) -> int | None:
    for point in curve:
        if point["pct_on_tissue"] >= target_pct:
            return point["n_annotated"]
    return None


def plot_discovery_curves(all_runs: dict, out_dir: Path) -> None:
    strategies = list(all_runs.keys())
    seed_sizes = sorted({s for strat in all_runs.values() for s in strat.keys()})

    fig, axes = plt.subplots(2, 3, figsize=(16, 10))
    axes = axes.flatten()
    colors = {"random": "#94a3b8", "coreset": "#3b82f6", "uncertainty": "#f59e0b"}

    for ax, seed_n in zip(axes, seed_sizes):
        for strategy in strategies:
            if seed_n not in all_runs[strategy]:
                continue
            replicates = all_runs[strategy][seed_n]
            # Align curves to common x axis
            max_x = max(max(p["n_annotated"] for p in r["curve"]) for r in replicates)
            xs = np.arange(1, max_x + 1)
            ys = []
            for r in replicates:
                curve_dict = {p["n_annotated"]: p["pct_on_tissue"] for p in r["curve"]}
                filled = []
                last = 0.0
                for x in xs:
                    if x in curve_dict:
                        last = curve_dict[x]
                    filled.append(last)
                ys.append(filled)
            ys = np.array(ys)
            mean_y = ys.mean(axis=0)
            std_y = ys.std(axis=0)
            ax.plot(xs, mean_y, label=strategy, color=colors.get(strategy, "black"))
            ax.fill_between(xs, mean_y - std_y, mean_y + std_y,
                            alpha=0.2, color=colors.get(strategy, "gray"))

        ax.set_title(f"Seed size N={seed_n}")
        ax.set_xlabel("Annotations done")
        ax.set_ylabel("% on-tissue found")
        ax.axhline(90, color="red", linestyle="--", alpha=0.5, label="90% target")
        if seed_n == seed_sizes[0]:
            ax.legend(fontsize=8)

    plt.suptitle("Discovery curves: on-tissue ion discovery by strategy", fontsize=12)
    plt.tight_layout()
    plt.savefig(out_dir / "04a_discovery_curves.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 04a_discovery_curves.png")


def plot_effort_savings(savings: dict, out_dir: Path) -> None:
    strategies = [s for s in savings.keys() if s != "random"]
    seed_sizes = SEED_SIZES

    fig, ax = plt.subplots(figsize=(10, 5))
    colors = {"coreset": "#3b82f6", "uncertainty": "#f59e0b"}

    for strategy in strategies:
        savings_pct = []
        for n in seed_sizes:
            rand_n = savings["random"].get(n, {}).get("median_to_90pct")
            strat_n = savings[strategy].get(n, {}).get("median_to_90pct")
            if rand_n and strat_n:
                savings_pct.append((1 - strat_n / rand_n) * 100)
            else:
                savings_pct.append(0)
        ax.plot(seed_sizes, savings_pct, marker="o", label=strategy,
                color=colors.get(strategy, "black"))

    ax.axhline(0, color="gray", linestyle="--")
    ax.set_xscale("log")
    ax.set_xlabel("Seed size N")
    ax.set_ylabel("Annotation savings vs random (%)")
    ax.set_title("Annotation effort saved by AL strategy to reach 90% on-tissue discovery")
    ax.legend()
    plt.tight_layout()
    plt.savefig(out_dir / "04b_effort_savings.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 04b_effort_savings.png")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--model-name", default="resnet50_offsample")
    parser.add_argument("--bucket", default="peakme-ions")
    parser.add_argument("--region", default="us-west-1")
    parser.add_argument("--out", default="results")
    parser.add_argument("--cache-dir", default="/tmp/ion_cache")
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cache_dir = Path(args.cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    print(f"Device: {device}")

    df = pd.read_csv(args.csv)
    df = df[~df["project_name"].isin(EXCLUDE_PROJECTS)].copy()
    df["label_norm"] = df["label_name"].map(LABEL_MAP)

    # Use fully annotated human project only for simulation
    human_df = df[
        (df["project_name"] == "GCPL") & df["label_norm"].isin(["on_tissue", "off_tissue"])
    ].copy().reset_index(drop=True)
    print(f"Human dataset for simulation: {len(human_df)} ions "
          f"({human_df['label_norm'].value_counts().to_dict()})")

    s3 = boto3.client("s3", region_name=args.region)
    model = load_model(args.model_name, args.model_path, device)

    STRATEGIES = ["random", "coreset", "uncertainty"]
    all_runs: dict = {s: {} for s in STRATEGIES}

    for seed_n in SEED_SIZES:
        if seed_n > len(human_df):
            print(f"Skipping N={seed_n} (larger than dataset)")
            continue
        print(f"\n=== Seed N={seed_n} ===")
        for strategy in STRATEGIES:
            replicates = []
            for rep in range(N_REPLICATES):
                rng_seed = 42 + rep * 1000 + seed_n
                print(f"  {strategy} rep {rep+1}/{N_REPLICATES}...", end=" ", flush=True)
                result = simulate_al(
                    human_df, model, s3, args.bucket, device, args,
                    cache_dir, seed_n, strategy, rng_seed
                )
                replicates.append(result)
                print(f"done ({result['curve'][-1]['n_on_tissue']}"
                      f"/{result['on_tissue_total']} on-tissue found)")
            all_runs[strategy][seed_n] = replicates

    # ── Compute savings table ─────────────────────────────────────────────────
    savings = {s: {} for s in STRATEGIES}
    for strategy in STRATEGIES:
        for seed_n in SEED_SIZES:
            if seed_n not in all_runs[strategy]:
                continue
            ns_to_90 = [find_n_to_reach(r["curve"], 90) for r in all_runs[strategy][seed_n]]
            ns_to_90 = [n for n in ns_to_90 if n is not None]
            savings[strategy][seed_n] = {
                "median_to_90pct": int(np.median(ns_to_90)) if ns_to_90 else None,
                "std_to_90pct": int(np.std(ns_to_90)) if len(ns_to_90) > 1 else None,
                "n_replicates_reached": len(ns_to_90),
            }

    # ── Print summary ─────────────────────────────────────────────────────────
    print("\n=== Annotation effort to reach 90% on-tissue discovery ===")
    rows = []
    for seed_n in SEED_SIZES:
        row = {"seed_N": seed_n}
        for s in STRATEGIES:
            row[s] = savings[s].get(seed_n, {}).get("median_to_90pct", "N/A")
        rows.append(row)
    print(pd.DataFrame(rows).to_string(index=False))

    # Find critical mass: smallest N where best AL beats random by >20%
    critical_mass = None
    for seed_n in SEED_SIZES:
        rand_n = savings["random"].get(seed_n, {}).get("median_to_90pct")
        best_al_n = min(
            (savings[s].get(seed_n, {}).get("median_to_90pct") or float("inf"))
            for s in ["coreset", "uncertainty"]
        )
        if rand_n and best_al_n < float("inf"):
            saving_pct = (rand_n - best_al_n) / rand_n * 100
            if saving_pct > 20:
                critical_mass = seed_n
                break

    print(f"\nCritical mass (first N where AL > random by >20%): {critical_mass}")

    # ── Plots ─────────────────────────────────────────────────────────────────
    plot_discovery_curves(all_runs, out_dir)
    plot_effort_savings(savings, out_dir)

    # ── Save results ──────────────────────────────────────────────────────────
    # Trim curves to reduce JSON size
    trimmed_runs = {}
    for strategy, by_seed in all_runs.items():
        trimmed_runs[strategy] = {}
        for seed_n, reps in by_seed.items():
            trimmed_runs[strategy][seed_n] = [
                {"on_tissue_total": r["on_tissue_total"],
                 "curve_sample": r["curve"][::10]}  # every 10th point
                for r in reps
            ]

    result = {
        "savings_to_90pct": savings,
        "critical_mass_threshold": critical_mass,
        "seed_sizes_tested": SEED_SIZES,
        "n_replicates": N_REPLICATES,
        "human_dataset_size": len(human_df),
        "curves_sampled": trimmed_runs,
    }

    json_path = out_dir / "04_al_curves.json"
    with open(json_path, "w") as f:
        json.dump(result, f, indent=2)
    print(f"\nSaved: {json_path}")


if __name__ == "__main__":
    main()
