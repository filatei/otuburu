# Module: linode-vpc
# Provisions a VPC with subnets for the Otuburu production environment.

terraform {
  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.28"
    }
  }
}

resource "linode_vpc" "main" {
  label       = "${var.name_prefix}-vpc"
  region      = var.region
  description = "Otuburu ${var.environment} VPC"
}

resource "linode_vpc_subnet" "private" {
  vpc_id = linode_vpc.main.id
  label  = "${var.name_prefix}-private"
  ipv4   = var.private_subnet_cidr
}

output "vpc_id"            { value = linode_vpc.main.id }
output "private_subnet_id" { value = linode_vpc_subnet.private.id }
