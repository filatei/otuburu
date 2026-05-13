# Module: linode-lke
# Provisions a Linode Kubernetes Engine cluster for Otuburu workloads.

terraform {
  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.28"
    }
  }
}

resource "linode_lke_cluster" "main" {
  label       = "${var.name_prefix}-lke"
  region      = var.region
  k8s_version = var.k8s_version
  tags        = var.tags

  pool {
    type  = var.node_type
    count = var.node_count

    autoscaler {
      min = var.node_count
      max = var.node_count * 3
    }
  }

  # Control-plane HA (recommended for production)
  control_plane {
    high_availability = var.environment == "production"
  }
}

output "cluster_id"   { value = linode_lke_cluster.main.id }
output "kubeconfig"   {
  value     = linode_lke_cluster.main.kubeconfig
  sensitive = true
}
output "api_endpoint" { value = linode_lke_cluster.main.api_endpoints[0] }
