"""Patch 04_active_learning_sim.py to add score_sorted strategy."""
import sys

path = "/home/ubuntu/scripts/04_active_learning_sim.py"
with open(path) as f:
    src = f.read()

# Insert score_sorted branch before the random branch
old = '    if strategy == "random":'
new = ('    if strategy == "score_sorted":\n'
       '        order = np.argsort(all_probs)[::-1]\n'
       '        return {"curve": _build_curve(order, labels, on_tissue_total),\n'
       '                "on_tissue_total": on_tissue_total}\n\n'
       '    if strategy == "random":')
if old not in src:
    print("ERROR: anchor not found"); sys.exit(1)
src = src.replace(old, new, 1)

# Add score_sorted to STRATEGIES list
src = src.replace(
    'STRATEGIES = ["random", "coreset", "uncertainty"]',
    'STRATEGIES = ["random", "score_sorted", "coreset", "uncertainty"]'
)

# Update colors dict in plot_effort_savings
src = src.replace(
    '    colors = {"coreset": "#3b82f6", "uncertainty": "#f59e0b"}',
    '    colors = {"score_sorted": "#22c55e", "coreset": "#3b82f6", "uncertainty": "#f59e0b"}'
)

with open(path, "w") as f:
    f.write(src)
print("PATCH_OK")
