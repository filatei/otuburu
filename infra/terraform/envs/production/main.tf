# Production environment
module "vpc" {
  source      = "../../modules/linode-vpc"
  name_prefix = "otuburu"
  region      = var.region
  environment = "production"
}

module "lke" {
  source      = "../../modules/linode-lke"
  name_prefix = "otuburu"
  region      = var.region
  environment = "production"
  node_count  = 3
  node_type   = "g6-standard-4"   # 4 vCPU / 8 GB RAM
  tags        = ["otuburu", "production"]
}

module "storage" {
  source      = "../../modules/object-storage"
  name_prefix = "otuburu"
  region      = var.region
  environment = "production"
}
