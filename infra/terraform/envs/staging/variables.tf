variable "linode_token" {
  description = "Linode API token — use TF_VAR_linode_token or terraform.tfvars (never commit)"
  type        = string
  sensitive   = true
}

variable "region" {
  type    = string
  default = "us-southeast"  # Atlanta — supports VPC + LKE
}

variable "environment" {
  type    = string
  default = "staging"
}

