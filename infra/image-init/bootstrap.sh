#!/usr/bin/env sh
# Bootstrap the LuxeCart image bucket on LocalStack (or any S3-compatible host).
# Run once at compose startup via the `image-init` service.

set -eu

: "${S3_ENDPOINT:=http://localstack:4566}"
: "${AWS_REGION:=us-east-1}"
: "${BUCKET:=luxecart-images}"

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
export AWS_DEFAULT_REGION="${AWS_REGION}"

echo "⌛ Waiting for LocalStack at ${S3_ENDPOINT}..."
until aws --endpoint-url "${S3_ENDPOINT}" s3 ls >/dev/null 2>&1; do
  sleep 2
done
echo "✅ LocalStack is up."

if aws --endpoint-url "${S3_ENDPOINT}" s3api head-bucket --bucket "${BUCKET}" 2>/dev/null; then
  echo "ℹ️  Bucket ${BUCKET} already exists."
else
  echo "📦 Creating bucket ${BUCKET}..."
  aws --endpoint-url "${S3_ENDPOINT}" s3api create-bucket --bucket "${BUCKET}"
fi

# Public-read so the browser can GET images served from LocalStack
echo "🔓 Setting bucket policy (public read)..."
cat >/tmp/policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "PublicReadGetObject",
    "Effect": "Allow",
    "Principal": "*",
    "Action": "s3:GetObject",
    "Resource": "arn:aws:s3:::${BUCKET}/*"
  }]
}
EOF
aws --endpoint-url "${S3_ENDPOINT}" s3api put-bucket-policy \
  --bucket "${BUCKET}" --policy file:///tmp/policy.json

# CORS so the browser can PUT via the presigned URL from http://localhost:3001
echo "🌐 Setting CORS..."
cat >/tmp/cors.json <<'EOF'
{
  "CORSRules": [{
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["GET", "PUT", "POST", "DELETE", "HEAD"],
    "AllowedOrigins": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}
EOF
aws --endpoint-url "${S3_ENDPOINT}" s3api put-bucket-cors \
  --bucket "${BUCKET}" --cors-configuration file:///tmp/cors.json

echo "🎉 Done. Bucket ${BUCKET} is ready."
