# Staging environment
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
  node_count  = 2
  node_type   = "g6-standard-2"
  tags        = ["otuburu", "staging"]
}

module "storage" {
  source      = "../../modules/object-storage"
  name_prefix = "otuburu-staging"
  region      = var.region
  environment = "staging"
}
