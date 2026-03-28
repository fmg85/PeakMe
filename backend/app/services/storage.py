"""
Storage service — abstracts S3 operations.

All S3 interactions in the app go through this module.
To swap storage backends (e.g. Cloudflare R2, GCS), only this file changes.
"""
import io
import threading
import uuid

import boto3
from botocore.exceptions import ClientError

from app.config import settings

# Per-thread client — boto3 clients are not thread-safe for concurrent calls,
# so each worker thread in the upload pool gets its own instance.
_thread_local = threading.local()


def get_s3_client():
    if not hasattr(_thread_local, "s3_client"):
        _thread_local.s3_client = boto3.client(
            "s3",
            region_name=settings.aws_region,
            aws_access_key_id=settings.aws_access_key_id,
            aws_secret_access_key=settings.aws_secret_access_key,
        )
    return _thread_local.s3_client


def upload_image(data: bytes, dataset_id: uuid.UUID, filename: str) -> str:
    """Upload a PNG to S3 and return its object key."""
    key = f"datasets/{dataset_id}/{filename}"
    get_s3_client().put_object(
        Bucket=settings.aws_s3_bucket,
        Key=key,
        Body=data,
        ContentType="image/png",
        CacheControl="public, max-age=31536000, immutable",
    )
    return key


def generate_presigned_url(key: str, expires_in: int = 3600) -> str:
    """Generate a presigned URL for an S3 object. Default TTL: 1 hour."""
    return get_s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.aws_s3_bucket, "Key": key},
        ExpiresIn=expires_in,
    )


def delete_dataset_images(dataset_id: uuid.UUID) -> None:
    """Delete all images for a dataset from S3."""
    client = get_s3_client()
    prefix = f"datasets/{dataset_id}/"
    paginator = client.get_paginator("list_objects_v2")
    pages = paginator.paginate(Bucket=settings.aws_s3_bucket, Prefix=prefix)
    objects = [
        {"Key": obj["Key"]}
        for page in pages
        for obj in page.get("Contents", [])
    ]
    if objects:
        client.delete_objects(
            Bucket=settings.aws_s3_bucket,
            Delete={"Objects": objects, "Quiet": True},
        )
