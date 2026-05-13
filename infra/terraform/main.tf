# Otuburu — Root Terraform configuration
# Provisions Linode infrastructure for torama.money
#
# Usage:
#   cd infra/terraform/envs/staging
#   terraform init
#   terraform plan -var-file=terraform.tfvars
#   terraform apply -var-file=terraform.tfvars

terraform {
  required_version = ">= 1.9"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.28"
    }
  }

  # Remote state — Linode Object Storage backend.
  # Uncomment once the bucket is created.
  # backend "s3" {
  #   bucket                      = "otuburu-tfstate"
  #   key                         = "terraform.tfstate"
  #   region                      = "us-east-1"         # ignored by Linode, required by provider
  #   endpoint                    = "us-east-1.linodeobjects.com"
  #   skip_credentials_validation = true
  #   skip_metadata_api_check     = true
  #   skip_region_validation      = true
  #   force_path_style            = true
  # }
}

provider "linode" {
  token = var.linode_token
}
