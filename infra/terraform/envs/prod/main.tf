# Example wiring of the two modules. Use this as a starting point for your env.
#
#   cd infra/terraform/envs/prod && terraform init && terraform apply

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.50"
    }
  }
}

provider "aws" {
  region = "us-east-1"
}

variable "bucket_name" {
  type    = string
  default = "luxecart-images-prod"
}

variable "cdn_aliases" {
  type    = list(string)
  default = []
}

variable "acm_certificate_arn" {
  type    = string
  default = null
}

locals {
  tags = {
    app         = "luxecart"
    component   = "images"
    environment = "prod"
    managed_by  = "terraform"
  }
}

# 1. Bucket — created without a policy to avoid the bucket ↔ CDN cycle.
module "s3_images" {
  source      = "../../modules/s3-images"
  bucket_name = var.bucket_name
  tags        = local.tags
  cors_allowed_origins = [
    "https://luxecart.com",
    "https://www.luxecart.com",
  ]
}

# 2. CDN reads from the bucket.
module "cdn" {
  source                             = "../../modules/cloudfront-cdn"
  comment                            = "LuxeCart images CDN (prod)"
  origin_bucket_regional_domain_name = module.s3_images.bucket_regional_domain_name
  aliases                            = var.cdn_aliases
  acm_certificate_arn                = var.acm_certificate_arn
  tags                               = local.tags
}

# 3. Bucket policy lives at the env level so the dependency graph stays acyclic.
data "aws_iam_policy_document" "cloudfront_read" {
  statement {
    sid       = "AllowCloudFrontServicePrincipalReadOnly"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${module.s3_images.bucket_arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [module.cdn.distribution_arn]
    }
  }
}

resource "aws_s3_bucket_policy" "cloudfront_read" {
  bucket = module.s3_images.bucket_id
  policy = data.aws_iam_policy_document.cloudfront_read.json
}

output "bucket_name" {
  value = module.s3_images.bucket_id
}

output "cdn_domain" {
  value = module.cdn.domain_name
}
