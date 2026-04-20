"""Export MobileNet-V3-Small to ONNX for production inference.

Downloads the trained .pt state dict from S3, reconstructs the model architecture
(matching 03_train_classifier.py exactly), wraps with softmax, exports to ONNX with
dynamic batch size, and uploads the .onnx file back to S3.

Run once before deploying the ML scoring feature. Requires torch + torchvision.

Usage:
    python research/scripts/export_onnx.py \
        --bucket peakme-ions \
        --pt-key research/results/model_mobilenet_v3_small.pt \
        --out-key research/results/model_mobilenet_v3_small.onnx \
        --region us-west-1
"""

import argparse
import tempfile
import os

import boto3
import torch
import torch.nn as nn
from torchvision import models
from torchvision.models import MobileNet_V3_Small_Weights


class _ModelWithSoftmax(nn.Module):
    def __init__(self, base: nn.Module):
        super().__init__()
        self._model = base

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return torch.softmax(self._model(x), dim=1)


def build_mobilenet() -> nn.Module:
    model = models.mobilenet_v3_small(weights=None)
    model.classifier[3] = nn.Linear(model.classifier[3].in_features, 2)
    return model


def export(bucket: str, pt_key: str, out_key: str, region: str) -> None:
    s3 = boto3.client("s3", region_name=region)

    print(f"Downloading {pt_key} from s3://{bucket}/...")
    with tempfile.NamedTemporaryFile(suffix=".pt", delete=False) as f:
        s3.download_fileobj(bucket, pt_key, f)
        pt_path = f.name

    try:
        model = build_mobilenet()
        state = torch.load(pt_path, map_location="cpu")
        model.load_state_dict(state)
        model.eval()
        print("Loaded state dict successfully.")
    finally:
        os.unlink(pt_path)

    wrapped = _ModelWithSoftmax(model)
    wrapped.eval()

    dummy = torch.zeros(1, 3, 224, 224)

    with tempfile.NamedTemporaryFile(suffix=".onnx", delete=False) as f:
        onnx_path = f.name

    try:
        torch.onnx.export(
            wrapped,
            dummy,
            onnx_path,
            opset_version=17,
            input_names=["input"],
            output_names=["probabilities"],
            dynamic_axes={
                "input": {0: "batch_size"},
                "probabilities": {0: "batch_size"},
            },
        )
        print(f"Exported ONNX to {onnx_path}")

        print(f"Uploading to s3://{bucket}/{out_key} ...")
        with open(onnx_path, "rb") as f:
            s3.put_object(Bucket=bucket, Key=out_key, Body=f.read())
        print("Done.")
    finally:
        os.unlink(onnx_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--pt-key", required=True, dest="pt_key")
    parser.add_argument("--out-key", required=True, dest="out_key")
    parser.add_argument("--region", default="us-west-1")
    args = parser.parse_args()
    export(args.bucket, args.pt_key, args.out_key, args.region)
