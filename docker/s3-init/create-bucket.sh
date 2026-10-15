#!/bin/sh
# LocalStack runs this once it is ready (mounted into /etc/localstack/init/ready.d by docker-compose.yml).
# It creates the local files bucket the way ADR-0007 describes the real one: private, versioned, and with
# CORS for the app origins only (the Vite dev server and the production-like stack of P1-08).
set -eu

BUCKET="${S3_BUCKET_NAME:-condo-app-dev-files}"

awslocal s3api create-bucket --bucket "$BUCKET" \
  --create-bucket-configuration LocationConstraint="$AWS_DEFAULT_REGION"
awslocal s3api put-bucket-versioning --bucket "$BUCKET" \
  --versioning-configuration Status=Enabled
awslocal s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["http://localhost:5173", "http://localhost:8080"],
    "AllowedMethods": ["GET", "HEAD", "POST"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}'
echo "create-bucket: $BUCKET ready (versioning, public access block, CORS)"
