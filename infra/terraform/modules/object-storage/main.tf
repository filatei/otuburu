# Module: object-storage
# Provisions Linode Object Storage buckets for Otuburu.
# Buckets:
#   - otuburu-tfstate       : Terraform remote state
#   - otuburu-tick-archive  : Compressed tick history (Parquet)
#   - otuburu-audit-logs    : Immutable audit trail

terraform {
  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.28"
    }
  }
}

locals {
  buckets = {
    tfstate      = "${var.name_prefix}-tfstate"
    tick-archive = "${var.name_prefix}-tick-archive"
    audit-logs   = "${var.name_prefix}-audit-logs"
  }
}

resource "linode_object_storage_bucket" "buckets" {
  for_each  = local.buckets
  cluster   = "${var.region}-1"
  label     = each.value
  acl       = "private"

  versioning = each.key == "tfstate"     # enable versioning on state bucket only
  lifecycle_rule {
    id      = "expire-old-ticks"
    enabled = each.key == "tick-archive"
    expiration { days = 365 }
  }
}

output "bucket_names" {
  value = { for k, b in linode_object_storage_bucket.buckets : k => b.label }
}
