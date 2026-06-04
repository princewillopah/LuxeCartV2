output "distribution_id" {
  description = "CloudFront distribution ID."
  value       = aws_cloudfront_distribution.this.id
}

output "distribution_arn" {
  description = "CloudFront distribution ARN (feed back into the s3-images module for bucket policy)."
  value       = aws_cloudfront_distribution.this.arn
}

output "domain_name" {
  description = "Default cloudfront.net domain name of the distribution."
  value       = aws_cloudfront_distribution.this.domain_name
}
