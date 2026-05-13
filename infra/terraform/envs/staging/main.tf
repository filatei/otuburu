# Staging environment
#
# Region: us-southeast (Atlanta) — VPC + LKE supported
# Object Storage is provisioned separately (requires S3 access/secret keys).

terraform {
  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.28"
    }
  }
}

provider "linode" {
  token = var.linode_token
}

module "vpc" {
  source      = "../../modules/linode-vpc"
  name_prefix = "otuburu-staging"
  region      = var.region
  environment = "staging"
}

module "lke" {
  source      = "../../modules/linode-lke"
  name_prefix = "otuburu-staging"
  region      = var.region
  environment = "staging"
  k8s_version = "1.30"
  node_count  = 2
  node_type   = "g6-standard-2"
  tags        = ["otuburu", "staging"]
}
