variable "comment" {
  description = "Human-readable comment for the distribution."
  type        = string
  default     = "LuxeCart images CDN"
}

variable "origin_bucket_regional_domain_name" {
  description = "Regional domain name of the origin S3 bucket (from the s3-images module)."
  type        = string
}

variable "aliases" {
  description = "Custom domain names (e.g. [\"cdn.luxecart.com\"]). Leave empty to use the default *.cloudfront.net domain."
  type        = list(string)
  default     = []
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (must be in us-east-1) when using custom aliases."
  type        = string
  default     = null
}

variable "price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}
