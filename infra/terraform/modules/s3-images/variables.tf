variable "bucket_name" {
  description = "Globally unique S3 bucket name for storing LuxeCart images."
  type        = string
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default     = {}
}

variable "noncurrent_version_expiration_days" {
  description = "Days to keep noncurrent object versions before permanent deletion."
  type        = number
  default     = 30
}

variable "abort_incomplete_multipart_days" {
  description = "Days before incomplete multipart uploads are aborted."
  type        = number
  default     = 7
}

variable "cors_allowed_origins" {
  description = "Origins permitted to PUT/GET objects (used by browser presigned uploads)."
  type        = list(string)
}
