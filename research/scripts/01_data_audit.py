"""
Phase 1: Data Audit
Reads annotations.csv from S3, produces summary statistics and plots.
Saves results to s3://peakme-ions/research/results/01_data_audit.json
and local results/ directory.

Usage:
    python 01_data_audit.py --csv /path/to/annotations.csv --out /path/to/results/
"""

import argparse
import json
import os
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

# ── Label normalisation ────────────────────────────────────────────────────────
LABEL_MAP = {
    "on tissue": "on_tissue",
    "On tissue": "on_tissue",
    "ON TISSUE": "on_tissue",
    "HP-associated": "on_tissue",   # Helicobacter pylori — biologically real
    "off tissue": "off_tissue",
    "Off tissue": "off_tissue",
    "Off-Tissue": "off_tissue",
    "OFF TISSUE": "off_tissue",
    "unclear": "unclear",
    "Unclear": "unclear",
    "UNCLEAR": "unclear",
}

BINARY_MAP = {
    "on_tissue": "on_tissue",
    "off_tissue": "off_tissue",
    "unclear": "unclear",  # excluded from binary training
}


def normalise_labels(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["label_norm"] = df["label_name"].map(LABEL_MAP)
    unknown = df["label_norm"].isna() & df["label_name"].notna()
    if unknown.any():
        print(f"WARNING: unmapped labels → {df.loc[unknown, 'label_name'].unique()}")
    return df


def project_summary(df: pd.DataFrame) -> dict:
    summary = {}
    for proj, grp in df.groupby("project_name"):
        ds_counts = grp.groupby("dataset_name").size().to_dict()
        label_counts = (
            grp["label_norm"].value_counts(dropna=False).to_dict()
        )
        total = len(grp)
        annotated = grp["label_norm"].notna().sum()
        summary[proj] = {
            "total_ions": total,
            "annotated_ions": int(annotated),
            "datasets": ds_counts,
            "label_counts": {str(k): int(v) for k, v in label_counts.items()},
            "label_pct": {
                str(k): round(int(v) / total * 100, 2)
                for k, v in label_counts.items()
            },
        }
    return summary


def cross_organism_mz_overlap(df: pd.DataFrame) -> dict:
    human = set(df[df["project_name"] == "GCPL"]["mz_value"].round(3))
    mouse_proj = [p for p in df["project_name"].unique() if "mouse" in p.lower()
                  or "M3" in p or "65D" in p]
    if not mouse_proj:
        mouse_proj = [p for p in df["project_name"].unique() if p != "GCPL"
                      and "test" not in p.lower() and "new" not in p.lower()]
    mouse = set()
    for p in mouse_proj:
        mouse |= set(df[df["project_name"] == p]["mz_value"].round(3))

    overlap = human & mouse
    return {
        "human_unique_mz": len(human),
        "mouse_unique_mz": len(mouse),
        "shared_mz_1mda": len(overlap),
        "pct_overlap_human": round(len(overlap) / len(human) * 100, 2) if human else 0,
        "pct_overlap_mouse": round(len(overlap) / len(mouse) * 100, 2) if mouse else 0,
    }


def dhap_artefact_candidates(df: pd.DataFrame, top_n: int = 50) -> list:
    """m/z values that are consistently labelled off_tissue across all datasets."""
    off = df[df["label_norm"] == "off_tissue"].copy()
    mz_rounded = off["mz_value"].round(4)
    # Count how many distinct datasets each m/z appears as off_tissue in
    hits = (
        off.assign(mz_r=mz_rounded)
        .groupby("mz_r")["dataset_id"]
        .nunique()
        .reset_index()
        .rename(columns={"dataset_id": "n_datasets_off_tissue"})
        .sort_values("n_datasets_off_tissue", ascending=False)
    )
    total_datasets = df["dataset_id"].nunique()
    hits["pct_datasets"] = (hits["n_datasets_off_tissue"] / total_datasets * 100).round(1)
    # Focus on low m/z (matrix cluster range < 600 Da) and high consistency
    candidates = hits[hits["mz_r"] < 600].head(top_n)
    return candidates.to_dict(orient="records")


def time_spent_analysis(df: pd.DataFrame) -> dict:
    ts = df["time_spent_ms"].dropna()
    if ts.empty:
        return {"note": "no time_spent_ms data"}
    by_label = df.groupby("label_norm")["time_spent_ms"].agg(
        ["median", "mean", "std", "count"]
    ).to_dict(orient="index")
    return {
        "overall_median_ms": float(ts.median()),
        "overall_mean_ms": float(ts.mean()),
        "by_label": {str(k): {kk: round(float(vv), 1) for kk, vv in v.items()}
                     for k, v in by_label.items()},
    }


def plot_label_distribution(df: pd.DataFrame, out_dir: Path) -> None:
    fig, axes = plt.subplots(1, len(df["project_name"].unique()), figsize=(14, 5))
    if not hasattr(axes, "__iter__"):
        axes = [axes]
    colors = {"on_tissue": "#22c55e", "off_tissue": "#ef4444", "unclear": "#f59e0b"}

    for ax, (proj, grp) in zip(axes, df.groupby("project_name")):
        counts = grp["label_norm"].value_counts()
        ax.bar(counts.index, counts.values,
               color=[colors.get(l, "#94a3b8") for l in counts.index])
        ax.set_title(proj, fontsize=10)
        ax.set_xlabel("Label")
        ax.set_ylabel("Count")
        for i, (label, count) in enumerate(counts.items()):
            ax.text(i, count + 10, f"{count/len(grp)*100:.1f}%",
                    ha="center", fontsize=8)

    plt.suptitle("Label distribution by project", fontsize=12)
    plt.tight_layout()
    plt.savefig(out_dir / "01a_label_distribution.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 01a_label_distribution.png")


def plot_mz_distribution(df: pd.DataFrame, out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(12, 5))
    colors = {"on_tissue": "#22c55e", "off_tissue": "#ef4444", "unclear": "#f59e0b"}
    for label, grp in df[df["label_norm"].isin(["on_tissue", "off_tissue"])].groupby("label_norm"):
        ax.hist(grp["mz_value"], bins=200, alpha=0.5,
                label=label, color=colors[label])
    ax.set_xlabel("m/z")
    ax.set_ylabel("Count")
    ax.set_title("m/z distribution by label")
    ax.legend()
    plt.tight_layout()
    plt.savefig(out_dir / "01b_mz_distribution.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 01b_mz_distribution.png")


def plot_dataset_breakdown(df: pd.DataFrame, out_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(12, 5))
    datasets = df["dataset_name"].unique()
    x = np.arange(len(datasets))
    width = 0.25
    colors = {"on_tissue": "#22c55e", "off_tissue": "#ef4444", "unclear": "#f59e0b"}
    for i, label in enumerate(["on_tissue", "off_tissue", "unclear"]):
        counts = [df[(df["dataset_name"] == d) & (df["label_norm"] == label)].shape[0]
                  for d in datasets]
        ax.bar(x + i * width, counts, width, label=label, color=colors[label])
    ax.set_xticks(x + width)
    ax.set_xticklabels(datasets, rotation=45, ha="right", fontsize=8)
    ax.set_ylabel("Count")
    ax.set_title("Label counts per dataset")
    ax.legend()
    plt.tight_layout()
    plt.savefig(out_dir / "01c_dataset_breakdown.png", dpi=150, bbox_inches="tight")
    plt.close()
    print("Saved: 01c_dataset_breakdown.png")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", required=True, help="Path to annotations.csv")
    parser.add_argument("--out", default="results", help="Output directory")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Loading {args.csv}...")
    df = pd.read_csv(args.csv)
    print(f"Loaded {len(df):,} rows")

    # Filter to research projects only
    exclude = {"test project", "new test", "65DNeoInfM3_10_test2"}
    df = df[~df["project_name"].isin(exclude)].copy()
    print(f"After filtering test projects: {len(df):,} rows")

    df = normalise_labels(df)

    # ── Summaries ─────────────────────────────────────────────────────────────
    result = {
        "total_rows": len(df),
        "annotated": int(df["label_norm"].notna().sum()),
        "unannotated": int(df["label_norm"].isna().sum()),
        "unique_datasets": int(df["dataset_id"].nunique()),
        "unique_projects": int(df["project_name"].nunique()),
        "projects": project_summary(df),
        "cross_organism_mz_overlap": cross_organism_mz_overlap(df),
        "dhap_artefact_candidates_top50": dhap_artefact_candidates(df),
        "time_spent": time_spent_analysis(df),
    }

    # ── Overall binary class balance ──────────────────────────────────────────
    binary_df = df[df["label_norm"].isin(["on_tissue", "off_tissue"])]
    label_counts = binary_df["label_norm"].value_counts().to_dict()
    result["binary_class_balance"] = {
        str(k): int(v) for k, v in label_counts.items()
    }
    result["class_ratio_off_to_on"] = round(
        label_counts.get("off_tissue", 0) / max(label_counts.get("on_tissue", 1), 1), 2
    )
    print(f"\nBinary class balance: {result['binary_class_balance']}")
    print(f"Off:On ratio = {result['class_ratio_off_to_on']:.2f}:1")

    # ── Plots ─────────────────────────────────────────────────────────────────
    plot_label_distribution(df, out_dir)
    plot_mz_distribution(df, out_dir)
    plot_dataset_breakdown(df, out_dir)

    # ── Save JSON ─────────────────────────────────────────────────────────────
    json_path = out_dir / "01_data_audit.json"
    with open(json_path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\nSaved: {json_path}")
    print("\n=== Summary ===")
    print(json.dumps({k: v for k, v in result.items()
                      if k not in ("projects", "dhap_artefact_candidates_top50")}, indent=2))


if __name__ == "__main__":
    main()
