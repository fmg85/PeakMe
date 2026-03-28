#!/usr/bin/env bash
# launch.sh — Launch an EC2 Spot instance for large Cardinal MSI processing jobs.
#
# HIBERNATION (default, SIZE=128):
#   The instance hibernates on Spot interruption and resumes from the exact mid-execution
#   point when capacity returns. Cardinal's process() calls are never lost.
#
# STOP+CHECKPOINT (SIZE=256):
#   256 GB instances exceed AWS's 150 GB hibernation limit. The instance stops on
#   interruption; R resumes from the last step-level .rds checkpoint.
#
# Usage:
#   export REGION=us-east-1 KEY_NAME=my-key S3_BUCKET=largemsiproc-checkpoints
#   bash aws/launch.sh
#
# Required env vars:
#   REGION          AWS region (e.g. us-east-1)
#   KEY_NAME        EC2 key pair name
#   S3_BUCKET       S3 bucket for checkpoints (created if absent)
#
# Optional env vars:
#   SIZE            128 (default, hibernation) | 256 (stop+checkpoint)
#   EBS_SIZE_GB     Data EBS size in GB (default: 800)
#   ROOT_EBS_GB     Root EBS size in GB (default: 200; must be >= RAM for hibernation)
#   EBS_VOLUME_ID   Existing data EBS volume ID to reuse (else creates new)
#   IAM_PROFILE     EC2 instance profile name (default: spot-r-job-profile)
#   REPO_URL        Git URL cloned to /mnt/ebs-data/work/ after boot (optional)

set -euo pipefail

# ── Defaults ──────────────────────────────────────────────────────────────────
SIZE="${SIZE:-128}"
EBS_SIZE_GB="${EBS_SIZE_GB:-800}"
ROOT_EBS_GB="${ROOT_EBS_GB:-200}"
EBS_VOLUME_ID="${EBS_VOLUME_ID:-}"
IAM_PROFILE="${IAM_PROFILE:-spot-r-job-profile}"
REPO_URL="${REPO_URL:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Validate required vars ────────────────────────────────────────────────────
for var in REGION KEY_NAME S3_BUCKET; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: \$$var is required. Set it before running this script." >&2
    exit 1
  fi
done

# ── Validate AWS credentials ──────────────────────────────────────────────────
echo "Validating AWS credentials..."
CALLER=$(aws sts get-caller-identity --region "$REGION" --output json 2>&1) || {
  echo "ERROR: AWS CLI not configured or credentials invalid." >&2
  echo "Run: aws configure" >&2
  exit 1
}
ACCOUNT=$(echo "$CALLER" | grep -o '"Account": "[^"]*"' | cut -d'"' -f4)
echo "  Account: $ACCOUNT  Region: $REGION"

# ── Instance type selection ───────────────────────────────────────────────────
case "$SIZE" in
  128)
    INSTANCE_TYPES=("r6i.4xlarge" "r5.4xlarge" "r6a.4xlarge")
    HIBERNATION=true
    INTERRUPTION_BEHAVIOR="hibernate"
    echo "Mode: 128 GB RAM — Spot hibernation enabled"
    ;;
  256)
    INSTANCE_TYPES=("r6i.8xlarge" "r5.8xlarge" "r6a.8xlarge")
    HIBERNATION=false
    INTERRUPTION_BEHAVIOR="stop"
    echo "Mode: 256 GB RAM — Stop+checkpoint (hibernation unavailable above 150 GB)"
    ;;
  *)
    echo "ERROR: SIZE must be 128 or 256." >&2
    exit 1
    ;;
esac

# ── Resolve latest Ubuntu 22.04 LTS AMI ──────────────────────────────────────
echo "Looking up latest Ubuntu 22.04 LTS AMI..."
AMI_ID=$(aws ec2 describe-images \
  --region "$REGION" \
  --owners 099720109477 \
  --filters \
    "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
    "Name=state,Values=available" \
    "Name=architecture,Values=x86_64" \
  --query 'sort_by(Images, &CreationDate)[-1].ImageId' \
  --output text)

if [[ -z "$AMI_ID" || "$AMI_ID" == "None" ]]; then
  echo "ERROR: Could not find Ubuntu 22.04 AMI in $REGION." >&2
  exit 1
fi
echo "  AMI: $AMI_ID"

# ── Ensure S3 checkpoint bucket exists ───────────────────────────────────────
echo "Ensuring S3 bucket: $S3_BUCKET"
if ! aws s3 ls "s3://$S3_BUCKET" --region "$REGION" &>/dev/null; then
  aws s3 mb "s3://$S3_BUCKET" --region "$REGION"
  echo "  Created s3://$S3_BUCKET"
else
  echo "  Already exists"
fi

# ── Create or reuse security group ───────────────────────────────────────────
SG_NAME="spot-r-job-sg"
echo "Setting up security group: $SG_NAME"

VPC_ID=$(aws ec2 describe-vpcs \
  --region "$REGION" \
  --filters "Name=isDefault,Values=true" \
  --query 'Vpcs[0].VpcId' --output text)

EXISTING_SG=$(aws ec2 describe-security-groups \
  --region "$REGION" \
  --filters "Name=group-name,Values=$SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo "None")

if [[ "$EXISTING_SG" == "None" || -z "$EXISTING_SG" ]]; then
  SG_ID=$(aws ec2 create-security-group \
    --region "$REGION" \
    --group-name "$SG_NAME" \
    --description "Spot R job: SSH + httpgd" \
    --vpc-id "$VPC_ID" \
    --query 'GroupId' --output text)
  # SSH
  aws ec2 authorize-security-group-ingress \
    --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 22 --cidr 0.0.0.0/0
  # httpgd for VS Code R extension
  aws ec2 authorize-security-group-ingress \
    --region "$REGION" --group-id "$SG_ID" \
    --protocol tcp --port 8888 --cidr 0.0.0.0/0
  echo "  Created: $SG_ID"
else
  SG_ID="$EXISTING_SG"
  echo "  Reusing: $SG_ID"
fi

# ── Prepare userdata (inject env vars at top) ─────────────────────────────────
USERDATA_FILE="$SCRIPT_DIR/userdata.sh"
if [[ ! -f "$USERDATA_FILE" ]]; then
  echo "ERROR: $USERDATA_FILE not found." >&2
  exit 1
fi

USERDATA_INJECTED=$(mktemp)
cat > "$USERDATA_INJECTED" <<HEADER
#!/usr/bin/env bash
# === Injected by launch.sh ===
export S3_BUCKET="${S3_BUCKET}"
export SIZE="${SIZE}"
export REPO_URL="${REPO_URL}"
# =============================
HEADER
# Append userdata.sh (skip its own shebang line)
tail -n +2 "$USERDATA_FILE" >> "$USERDATA_INJECTED"
USERDATA_B64=$(base64 -w 0 "$USERDATA_INJECTED")
rm -f "$USERDATA_INJECTED"

# ── Block device mappings ─────────────────────────────────────────────────────
# Root EBS: encrypted (required for hibernation on SIZE=128), gp3
ROOT_BDM="[{\"DeviceName\":\"/dev/sda1\",\"Ebs\":{\"VolumeSize\":${ROOT_EBS_GB},\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":true}}]"

# ── Spot market options ───────────────────────────────────────────────────────
if [[ "$HIBERNATION" == "true" ]]; then
  MARKET_OPTS="{\"MarketType\":\"spot\",\"SpotOptions\":{\"SpotInstanceType\":\"persistent\",\"InstanceInterruptionBehavior\":\"${INTERRUPTION_BEHAVIOR}\"}}"
else
  MARKET_OPTS="{\"MarketType\":\"spot\",\"SpotOptions\":{\"SpotInstanceType\":\"persistent\",\"InstanceInterruptionBehavior\":\"${INTERRUPTION_BEHAVIOR}\"}}"
fi

# ── Launch instance (try each instance type in order) ─────────────────────────
echo "Launching Spot instance (trying ${INSTANCE_TYPES[*]})..."
INSTANCE_ID=""
INSTANCE_TYPE_USED=""

for ITYPE in "${INSTANCE_TYPES[@]}"; do
  echo "  Trying $ITYPE..."

  EXTRA_FLAGS=()
  if [[ "$HIBERNATION" == "true" ]]; then
    EXTRA_FLAGS+=(--hibernation-options "Configured=true")
  fi

  RESULT=$(aws ec2 run-instances \
    --region "$REGION" \
    --image-id "$AMI_ID" \
    --instance-type "$ITYPE" \
    --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --iam-instance-profile "Name=$IAM_PROFILE" \
    --instance-market-options "$MARKET_OPTS" \
    --block-device-mappings "$ROOT_BDM" \
    --user-data "$USERDATA_B64" \
    --tag-specifications \
      "ResourceType=instance,Tags=[{Key=Name,Value=spot-r-job},{Key=Project,Value=LargeMSIproc}]" \
    "${EXTRA_FLAGS[@]}" \
    --output json 2>&1) && {
      INSTANCE_ID=$(echo "$RESULT" | grep -o '"InstanceId": "[^"]*"' | head -1 | cut -d'"' -f4)
      INSTANCE_TYPE_USED="$ITYPE"
      echo "  Launched: $INSTANCE_ID ($ITYPE)"
      break
    } || {
      echo "  Failed ($ITYPE): capacity unavailable or unsupported, trying next..."
    }
done

if [[ -z "$INSTANCE_ID" ]]; then
  echo "ERROR: Could not launch Spot instance with any of: ${INSTANCE_TYPES[*]}" >&2
  echo "Try a different region or set SIZE=256 for more instance options." >&2
  exit 1
fi

# ── Wait for running state ────────────────────────────────────────────────────
echo "Waiting for instance to reach running state..."
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
echo "  Instance is running"

# ── Get AZ and public IP ──────────────────────────────────────────────────────
INSTANCE_INFO=$(aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].{AZ:Placement.AvailabilityZone,IP:PublicIpAddress}' \
  --output json)
AZ=$(echo "$INSTANCE_INFO" | grep -o '"AZ": "[^"]*"' | cut -d'"' -f4)
PUBLIC_IP=$(echo "$INSTANCE_INFO" | grep -o '"IP": "[^"]*"' | cut -d'"' -f4)

# ── Attach or create data EBS volume ─────────────────────────────────────────
if [[ -n "$EBS_VOLUME_ID" ]]; then
  echo "Attaching existing data EBS: $EBS_VOLUME_ID"
  aws ec2 attach-volume \
    --region "$REGION" \
    --volume-id "$EBS_VOLUME_ID" \
    --instance-id "$INSTANCE_ID" \
    --device /dev/xvdf
  echo "  Attached $EBS_VOLUME_ID"
else
  echo "Creating new data EBS volume (${EBS_SIZE_GB} GB gp3 in $AZ)..."
  DATA_VOL_ID=$(aws ec2 create-volume \
    --region "$REGION" \
    --availability-zone "$AZ" \
    --volume-type gp3 \
    --size "$EBS_SIZE_GB" \
    --tag-specifications \
      "ResourceType=volume,Tags=[{Key=Name,Value=spot-r-job-data},{Key=Project,Value=LargeMSIproc}]" \
    --query 'VolumeId' --output text)
  echo "  Created: $DATA_VOL_ID"

  echo "  Waiting for volume to be available..."
  aws ec2 wait volume-available --region "$REGION" --volume-ids "$DATA_VOL_ID"

  aws ec2 attach-volume \
    --region "$REGION" \
    --volume-id "$DATA_VOL_ID" \
    --instance-id "$INSTANCE_ID" \
    --device /dev/xvdf
  echo "  Attached $DATA_VOL_ID → /dev/xvdf"
  echo ""
  echo "  IMPORTANT: To reuse this volume on the next job run, set:"
  echo "    export EBS_VOLUME_ID=$DATA_VOL_ID"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo " Spot instance launched"
echo "═══════════════════════════════════════════════════════"
echo " Instance ID    : $INSTANCE_ID"
echo " Instance type  : $INSTANCE_TYPE_USED"
echo " RAM            : ${SIZE} GB"
echo " Hibernation    : $HIBERNATION"
echo " Public IP      : $PUBLIC_IP"
echo " Region / AZ    : $REGION / $AZ"
echo " S3 bucket      : s3://$S3_BUCKET"
echo ""
echo " SSH:"
echo "   ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${PUBLIC_IP}"
echo ""
echo " Wait for userdata to complete before connecting (~15 min for R + Cardinal install):"
echo "   ssh -i ~/.ssh/${KEY_NAME}.pem ubuntu@${PUBLIC_IP} 'while [ ! -f /var/lib/userdata-complete ]; do sleep 10; done; echo done'"
echo ""
echo " Upload imzML data to S3:"
echo "   aws s3 cp your_data.imzML s3://${S3_BUCKET}/inputs/"
echo ""
echo " Then on the instance, copy to local EBS:"
echo "   aws s3 cp s3://${S3_BUCKET}/inputs/your_data.imzML /mnt/ebs-data/inputs/"
echo ""
if [[ "$HIBERNATION" == "false" ]]; then
  echo " NOTE (SIZE=256): Hibernation unavailable. Jobs resume from last step-level"
  echo " checkpoint if interrupted. Mid-step work will be lost."
  echo ""
fi
echo "═══════════════════════════════════════════════════════"
