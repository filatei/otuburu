variable "linode_token" {
  description = "Linode API token — use TF_VAR_linode_token or terraform.tfvars (never commit)"
  type        = string
  sensitive   = true
}

variable "region" {
  type    = string
  default = "us-east"
}

variable "environment" {
  type    = string
  default = "production"
}

variable "db_password" {
  type      = string
  sensitive = true
}
