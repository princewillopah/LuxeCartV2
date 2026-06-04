output "bucket_id" {
  description = "Name of the created S3 bucket."
  value       = aws_s3_bucket.this.id
}

output "bucket_arn" {
  description = "ARN of the created S3 bucket."
  value       = aws_s3_bucket.this.arn
}

output "bucket_regional_domain_name" {
  description = "Regional domain name (use as CloudFront origin)."
  value       = aws_s3_bucket.this.bucket_regional_domain_name
}
