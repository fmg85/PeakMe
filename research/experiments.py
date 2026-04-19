"""
PeakMe ML Research — Ion Image Classification Experiments
==========================================================
Strategy: extract ResNet-18 embeddings ONCE (frozen backbone),
then run all experiments on 512-dim vectors — orders of magnitude
faster than full fine-tuning on CPU.

Experiments:
  1. Baseline — PCA (64px pixel features) + LogReg             (sanity check)
  2. ResNet-18 embeddings + LogReg, GCPL 5-fold CV             (main result)
  3. Cross-species — train GCPL human, test 65D mouse          (transfer)
  4. Learning curve — AUC vs N labeled, balanced sample        (min data needed)
  5. Ranking quality — uncertainty ordering vs random          (core UX value)
"""

import os, random, time, json
import numpy as np
import pandas as pd
from pathlib import Path
from PIL import Image
from sklearn.linear_model import LogisticRegression
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import (classification_report, roc_auc_score)
from sklearn.model_selection import StratifiedKFold, train_test_split
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

import torch
import torchvision.transforms as T
import torchvision.models as models
from torch.utils.data import Dataset, DataLoader

SEED = 42
random.seed(SEED); np.random.seed(SEED); torch.manual_seed(SEED)

IMG_DIR  = Path('/home/user/PeakMe/research/images')
DATA_CSV = Path('/home/user/PeakMe/research/annotations.csv')
OUT_DIR  = Path('/home/user/PeakMe/research/results')
EMB_FILE = OUT_DIR / 'embeddings.npz'
OUT_DIR.mkdir(exist_ok=True)

LABEL_MAP = {
    'off tissue':'off_tissue','Off-Tissue':'off_tissue',
    'on tissue':'on_tissue','Tiissue':'on_tissue',
}

# ─── Data loading ─────────────────────────────────────────────────────────────

def load_manifest():
    df = pd.read_csv(DATA_CSV)
    df['label_clean'] = df['label_name'].map(LABEL_MAP)
    binary = df[df['label_clean'].isin(['on_tissue','off_tissue'])].copy()
    binary['local_path'] = binary.apply(lambda r:
        str(IMG_DIR / r['label_clean'] / f"{r['dataset_id'][:8]}_{r['image_key'].split('/')[-1]}"), axis=1)
    binary['exists'] = binary['local_path'].apply(os.path.exists)
    df_out = binary[binary['exists']].reset_index(drop=True)
    df_out['y'] = (df_out['label_clean'] == 'on_tissue').astype(int)
    print(f"Manifest: {len(df_out)} images on disk | "
          f"on={df_out['y'].sum()} off={(df_out['y']==0).sum()}")
    return df_out

class IonDataset(Dataset):
    TF = T.Compose([
        T.Resize((224, 224)),
        T.ToTensor(),
        T.Normalize([0.05, 0.02, 0.10], [0.08, 0.04, 0.12]),
    ])
    def __init__(self, paths):
        self.paths = paths
    def __len__(self): return len(self.paths)
    def __getitem__(self, idx):
        return self.TF(Image.open(self.paths[idx]).convert('RGB'))

# ─── Step 0: Extract embeddings (one-time, cached) ───────────────────────────

def extract_embeddings(df):
    if EMB_FILE.exists():
        print("Loading cached embeddings...")
        data = np.load(EMB_FILE)
        return data['embeddings'], data['indices']

    print("Extracting ResNet-18 embeddings (this takes ~20-40 min on CPU)...")
    device = torch.device('cpu')
    torch.set_num_threads(16)
    model = models.resnet18(weights='IMAGENET1K_V1')
    # remove final FC — output is 512-dim avg-pool features
    model = torch.nn.Sequential(*list(model.children())[:-1])
    model.eval()
    model.to(device)

    ds = IonDataset(df['local_path'].tolist())
    dl = DataLoader(ds, batch_size=128, shuffle=False, num_workers=8, pin_memory=False)

    embeddings = []
    t0 = time.time()
    with torch.no_grad():
        for i, batch in enumerate(dl):
            emb = model(batch.to(device)).squeeze(-1).squeeze(-1).cpu().numpy()
            embeddings.append(emb)
            if (i+1) % 20 == 0:
                done = (i+1) * 128
                elapsed = time.time() - t0
                eta = elapsed / done * (len(df) - done)
                print(f"  {done}/{len(df)}  elapsed={elapsed/60:.1f}min  ETA={eta/60:.1f}min")

    embeddings = np.vstack(embeddings)
    indices = np.arange(len(df))
    np.savez(EMB_FILE, embeddings=embeddings, indices=indices)
    print(f"Embeddings shape: {embeddings.shape}  saved → {EMB_FILE}")
    return embeddings, indices

def logreg(X_train, y_train, X_val=None, y_val=None):
    scaler = StandardScaler()
    X_tr = scaler.fit_transform(X_train)
    X_v  = scaler.transform(X_val) if X_val is not None else None
    clf = LogisticRegression(class_weight='balanced', max_iter=1000,
                             C=1.0, random_state=SEED, n_jobs=-1)
    clf.fit(X_tr, y_train)
    if X_v is not None:
        probs = clf.predict_proba(X_v)[:, 1]
        return clf, scaler, probs
    return clf, scaler

# ─── Experiment 1: Pixel baseline ────────────────────────────────────────────

def exp1_pixel_baseline(df):
    print("\n" + "="*60)
    print("EXP 1: Pixel features (64px) + PCA + LogReg  [GCPL 5-fold CV]")
    print("="*60)
    gcpl = df[df['project_name'] == 'GCPL'].reset_index(drop=True)
    print(f"Loading {len(gcpl)} images at 64px...")
    t0 = time.time()
    X = np.array([
        np.array(Image.open(p).convert('RGB').resize((64,64))).flatten() / 255.
        for p in gcpl['local_path']
    ], dtype=np.float32)
    print(f"  Done in {time.time()-t0:.0f}s")

    scaler = StandardScaler()
    pca = PCA(n_components=100, random_state=SEED)
    X_pca = pca.fit_transform(scaler.fit_transform(X))
    print(f"  PCA variance explained (100 components): {pca.explained_variance_ratio_.sum():.1%}")

    y = gcpl['y'].values
    cv = StratifiedKFold(5, shuffle=True, random_state=SEED)
    aucs = []
    for fold, (tr, va) in enumerate(cv.split(X_pca, y)):
        clf = LogisticRegression(class_weight='balanced', max_iter=500, random_state=SEED, n_jobs=-1)
        clf.fit(X_pca[tr], y[tr])
        auc = roc_auc_score(y[va], clf.predict_proba(X_pca[va])[:,1])
        aucs.append(auc)
        print(f"  fold {fold+1}: AUC={auc:.3f}")
    r = {'experiment':'pixel_baseline', 'mean_auc':float(np.mean(aucs)), 'std':float(np.std(aucs))}
    print(f"  Mean AUC: {r['mean_auc']:.3f} ± {r['std']:.3f}")
    with open(OUT_DIR/'exp1_pixel_baseline.json','w') as f: json.dump(r, f, indent=2)
    return r

# ─── Experiment 2: ResNet embeddings + LogReg, GCPL 5-fold ───────────────────

def exp2_resnet_gcpl(df, emb):
    print("\n" + "="*60)
    print("EXP 2: ResNet-18 embeddings + LogReg  [GCPL 5-fold CV]")
    print("="*60)
    gcpl = df[df['project_name'] == 'GCPL']
    idx  = gcpl.index.values
    X, y = emb[idx], gcpl['y'].values
    print(f"GCPL: {len(y)} ions | on={y.sum()} off={(y==0).sum()}")

    cv = StratifiedKFold(5, shuffle=True, random_state=SEED)
    aucs, f1s_on, f1s_off = [], [], []
    all_probs = np.zeros(len(y))
    fold_val_indices = np.zeros(len(y), dtype=int)

    for fold, (tr, va) in enumerate(cv.split(X, y)):
        _, _, probs = logreg(X[tr], y[tr], X[va], y[va])
        auc = roc_auc_score(y[va], probs)
        preds = (probs > 0.5).astype(int)
        rep = classification_report(y[va], preds,
              target_names=['off_tissue','on_tissue'], output_dict=True)
        aucs.append(auc)
        f1s_on.append(rep['on_tissue']['f1-score'])
        f1s_off.append(rep['off_tissue']['f1-score'])
        all_probs[va] = probs
        fold_val_indices[va] = fold
        print(f"  fold {fold+1}: AUC={auc:.3f}  F1_on={rep['on_tissue']['f1-score']:.3f}  "
              f"F1_off={rep['off_tissue']['f1-score']:.3f}  "
              f"prec_on={rep['on_tissue']['precision']:.3f}  rec_on={rep['on_tissue']['recall']:.3f}")

    print(f"\n  Mean AUC:      {np.mean(aucs):.3f} ± {np.std(aucs):.3f}")
    print(f"  Mean F1 on:    {np.mean(f1s_on):.3f} ± {np.std(f1s_on):.3f}")
    print(f"  Mean F1 off:   {np.mean(f1s_off):.3f} ± {np.std(f1s_off):.3f}")

    # Save full GCPL predictions for exp5
    pred_df = gcpl.copy()
    pred_df['prob_on_tissue'] = all_probs
    pred_df.to_csv(OUT_DIR/'exp2_gcpl_predictions.csv', index=False)

    r = {'experiment':'resnet_gcpl_cv', 'mean_auc':float(np.mean(aucs)),
         'std_auc':float(np.std(aucs)), 'mean_f1_on':float(np.mean(f1s_on)),
         'mean_f1_off':float(np.mean(f1s_off)), 'folds':aucs}
    with open(OUT_DIR/'exp2_resnet_gcpl.json','w') as f: json.dump(r, f, indent=2)
    return r, all_probs, gcpl

# ─── Experiment 3: Cross-species ─────────────────────────────────────────────

def exp3_cross_species(df, emb):
    print("\n" + "="*60)
    print("EXP 3: Cross-species — train GCPL (human), test 65D (mouse)")
    print("="*60)
    gcpl  = df[df['project_name'] == 'GCPL']
    mouse = df[df['project_name'] == '65DNeoInfM3_10_test']
    print(f"Train (human GCPL): {len(gcpl)}  |  Test (mouse 65D): {len(mouse)}")
    print(f"  Mouse: on={mouse['y'].sum()} off={(mouse['y']==0).sum()}")

    X_tr, y_tr = emb[gcpl.index.values], gcpl['y'].values
    X_te, y_te = emb[mouse.index.values], mouse['y'].values

    _, _, probs = logreg(X_tr, y_tr, X_te, y_te)
    auc = roc_auc_score(y_te, probs)
    preds = (probs > 0.5).astype(int)
    print(f"\n  Cross-species AUC: {auc:.3f}")
    print(classification_report(y_te, preds, target_names=['off_tissue','on_tissue']))

    # Also reverse: train mouse, test human (very few mouse labels)
    X_tr2, y_tr2 = emb[mouse.index.values], mouse['y'].values
    X_te2, y_te2 = emb[gcpl.index.values], gcpl['y'].values
    _, _, probs2 = logreg(X_tr2, y_tr2, X_te2, y_te2)
    auc2 = roc_auc_score(y_te2, probs2)
    print(f"\n  Reverse (mouse→human) AUC: {auc2:.3f}")

    r = {'experiment':'cross_species', 'human_to_mouse_auc':float(auc),
         'mouse_to_human_auc':float(auc2)}
    with open(OUT_DIR/'exp3_cross_species.json','w') as f: json.dump(r, f, indent=2)
    return r

# ─── Experiment 4: Learning curve ────────────────────────────────────────────

def exp4_learning_curve(df, emb):
    print("\n" + "="*60)
    print("EXP 4: Learning curve — AUC vs number of labeled samples")
    print("="*60)
    gcpl = df[df['project_name'] == 'GCPL'].reset_index(drop=True)
    X    = emb[df[df['project_name']=='GCPL'].index.values]
    y    = gcpl['y'].values

    # Fixed 20% holdout, stratified
    X_tr, X_val, y_tr, y_val, idx_tr, idx_val = train_test_split(
        X, y, np.arange(len(y)), test_size=0.2, stratify=y, random_state=SEED)

    on_idx  = np.where(y_tr == 1)[0]
    off_idx = np.where(y_tr == 0)[0]
    sizes   = [25, 50, 100, 200, 400, 800, 1500, 3000, len(y_tr)]
    results = []

    for n in sizes:
        n_per_class = n // 2
        n_on  = min(n_per_class, len(on_idx))
        n_off = min(n_per_class, len(off_idx))
        sel = np.concatenate([
            np.random.choice(on_idx,  n_on,  replace=False),
            np.random.choice(off_idx, n_off, replace=False),
        ])
        clf = LogisticRegression(class_weight='balanced', max_iter=500,
                                  C=1.0, random_state=SEED, n_jobs=-1)
        sc  = StandardScaler()
        clf.fit(sc.fit_transform(X_tr[sel]), y_tr[sel])
        probs = clf.predict_proba(sc.transform(X_val))[:,1]
        auc   = roc_auc_score(y_val, probs)
        preds = (probs > 0.5).astype(int)
        rep   = classification_report(y_val, preds,
                  target_names=['off_tissue','on_tissue'], output_dict=True)
        f1_on = rep['on_tissue']['f1-score']
        actual = n_on + n_off
        results.append({'n':actual,'n_on':int(n_on),'n_off':int(n_off),
                        'auc':float(auc),'f1_on':float(f1_on)})
        print(f"  n={actual:>5} (on={n_on}, off={n_off}): AUC={auc:.3f}  F1_on={f1_on:.3f}")

    with open(OUT_DIR/'exp4_learning_curve.json','w') as f: json.dump(results, f, indent=2)

    # Plot
    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    ns   = [r['n'] for r in results]
    aucs = [r['auc'] for r in results]
    f1s  = [r['f1_on'] for r in results]
    for ax, vals, ylabel, title, tgt in zip(axes, [aucs,f1s],
        ['ROC-AUC','F1 (on_tissue)'],
        ['ROC-AUC vs Training Size','on_tissue F1 vs Training Size'],
        [0.9, 0.7]):
        ax.semilogx(ns, vals, 'o-', color='steelblue', lw=2, ms=7)
        ax.axhline(tgt, color='gray', ls='--', alpha=0.6, label=f'target={tgt}')
        ax.set_xlabel('Labeled samples (balanced on+off)'); ax.set_ylabel(ylabel)
        ax.set_title(title); ax.legend(); ax.grid(True, alpha=0.3)
        ax.set_ylim(0, 1)
    plt.tight_layout()
    plt.savefig(OUT_DIR/'exp4_learning_curve.png', dpi=130, bbox_inches='tight')
    plt.close()
    print(f"  → results/exp4_learning_curve.png")
    return results

# ─── Experiment 5: Ranking quality ───────────────────────────────────────────

def exp5_ranking(df, emb):
    print("\n" + "="*60)
    print("EXP 5: Uncertainty ranking quality — does sorted order surface on_tissue?")
    print("="*60)
    pred_path = OUT_DIR / 'exp2_gcpl_predictions.csv'
    if not pred_path.exists():
        print("  Run exp2 first — skipping"); return {}

    pred_df = pd.read_csv(pred_path)
    p = pred_df['prob_on_tissue'].clip(1e-7, 1-1e-7)
    pred_df['entropy'] = (-p * np.log2(p) - (1-p) * np.log2(1-p))
    n_total = len(pred_df)
    n_on    = (pred_df['label_clean'] == 'on_tissue').sum()
    print(f"  {n_total} ions | {n_on} on_tissue ({n_on/n_total:.1%})")

    strategies = {
        'on_tissue_first (sort by P_on ↓)': pred_df.sort_values('prob_on_tissue', ascending=False),
        'uncertainty_first (entropy ↓)':     pred_df.sort_values('entropy', ascending=False),
        'off_tissue_first (sort by P_on ↑)': pred_df.sort_values('prob_on_tissue', ascending=True),
        'random':                             pred_df.sample(frac=1, random_state=SEED),
    }
    checkpoints = [0.05, 0.10, 0.20, 0.30, 0.50]
    results = {}
    print(f"\n  {'Strategy':<40} " + "  ".join(f"{p:.0%}" for p in checkpoints))
    print("  " + "-"*80)
    for name, sdf in strategies.items():
        recalls = []
        for pct in checkpoints:
            top_k = max(1, int(pct * n_total))
            found = (sdf.head(top_k)['label_clean'] == 'on_tissue').sum()
            recalls.append(found / n_on)
        print(f"  {name:<40} " + "  ".join(f"{r:.1%}" for r in recalls))
        results[name] = [{'pct':p,'recall':r} for p,r in zip(checkpoints,recalls)]

    # Score distribution plot
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 4))
    for label, color in [('on_tissue','steelblue'),('off_tissue','tomato')]:
        sub = pred_df[pred_df['label_clean']==label]['prob_on_tissue']
        ax1.hist(sub, bins=60, alpha=0.65, color=color, label=label, density=True)
    ax1.set_xlabel('P(on_tissue)'); ax1.set_ylabel('Density')
    ax1.set_title('Model score distribution by label'); ax1.legend()

    # Cumulative recall curves
    ax2.set_xlabel('Fraction of ions reviewed'); ax2.set_ylabel('Fraction of on_tissue found')
    cols = {'on_tissue_first (sort by P_on ↓)':'steelblue',
            'uncertainty_first (entropy ↓)':'orange',
            'off_tissue_first (sort by P_on ↑)':'tomato',
            'random':'gray'}
    for name, sdf in strategies.items():
        xs, ys = [], []
        for pct in np.linspace(0, 1, 100):
            top_k = max(1, int(pct * n_total))
            found = (sdf.head(top_k)['label_clean'] == 'on_tissue').sum()
            xs.append(pct); ys.append(found / n_on)
        ls = '--' if name == 'random' else '-'
        ax2.plot(xs, ys, label=name[:30], color=cols.get(name,'purple'), ls=ls, lw=2)
    ax2.plot([0,1],[0,1],'k--',alpha=0.3,label='random (ref)')
    ax2.legend(fontsize=7); ax2.set_title('Cumulative on_tissue recall by review order')
    plt.tight_layout()
    plt.savefig(OUT_DIR/'exp5_ranking.png', dpi=130, bbox_inches='tight')
    plt.close()
    print(f"\n  → results/exp5_ranking.png")

    with open(OUT_DIR/'exp5_ranking.json','w') as f: json.dump(results, f, indent=2, default=str)
    return results

# ─── Experiment 6: Per-dataset breakdown (cross-sample within GCPL) ──────────

def exp6_gcpl_per_dataset(df, emb):
    print("\n" + "="*60)
    print("EXP 6: Leave-one-GCPL-dataset-out — generalization across human samples")
    print("="*60)
    gcpl = df[df['project_name'] == 'GCPL'].copy()
    datasets = gcpl['dataset_name'].unique()
    results = []
    for held_out in datasets:
        train = gcpl[gcpl['dataset_name'] != held_out]
        test  = gcpl[gcpl['dataset_name'] == held_out]
        X_tr, y_tr = emb[train.index.values], train['y'].values
        X_te, y_te = emb[test.index.values],  test['y'].values
        _, _, probs = logreg(X_tr, y_tr, X_te, y_te)
        auc  = roc_auc_score(y_te, probs)
        preds = (probs > 0.5).astype(int)
        rep  = classification_report(y_te, preds, target_names=['off_tissue','on_tissue'], output_dict=True)
        n_on = int(y_te.sum()); n_off = int((y_te==0).sum())
        print(f"  held_out={held_out:<20} n={len(y_te)} (on={n_on} off={n_off})  "
              f"AUC={auc:.3f}  F1_on={rep['on_tissue']['f1-score']:.3f}")
        results.append({'dataset':held_out,'n':len(y_te),'n_on':n_on,'auc':float(auc),
                        'f1_on':float(rep['on_tissue']['f1-score'])})

    mean_auc = np.mean([r['auc'] for r in results])
    print(f"\n  Mean leave-one-out AUC: {mean_auc:.3f}")
    with open(OUT_DIR/'exp6_gcpl_lodo.json','w') as f: json.dump(results, f, indent=2)
    return results


# ─── Main ─────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("="*60)
    print("PeakMe ML Research — Ion Image Classification")
    print("="*60)

    df = load_manifest()
    print(f"\nProjects: {df['project_name'].value_counts().to_dict()}\n")

    # Extract embeddings (cached after first run)
    emb, _ = extract_embeddings(df)
    print(f"Embeddings ready: {emb.shape}\n")

    results = {}
    results['exp1_pixel']    = exp1_pixel_baseline(df)
    results['exp2_resnet']   = exp2_resnet_gcpl(df, emb)[0]
    results['exp3_species']  = exp3_cross_species(df, emb)
    results['exp4_curve']    = exp4_learning_curve(df, emb)
    results['exp5_ranking']  = exp5_ranking(df, emb)
    results['exp6_lodo']     = exp6_gcpl_per_dataset(df, emb)

    print("\n" + "="*60)
    print("SUMMARY")
    print("="*60)
    print(f"  Pixel baseline AUC:          {results['exp1_pixel']['mean_auc']:.3f}")
    print(f"  ResNet-18 GCPL AUC:          {results['exp2_resnet']['mean_auc']:.3f}")
    print(f"  Cross-species (human→mouse): {results['exp3_species']['human_to_mouse_auc']:.3f}")
    print(f"  Cross-species (mouse→human): {results['exp3_species']['mouse_to_human_auc']:.3f}")

    with open(OUT_DIR/'all_results.json','w') as f:
        json.dump(results, f, indent=2, default=str)
    print(f"\nAll results → {OUT_DIR}")
