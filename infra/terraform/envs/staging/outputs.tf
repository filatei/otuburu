output "vpc_id" {
  description = "Staging VPC ID"
  value       = module.vpc.vpc_id
}

output "lke_cluster_id" {
  description = "Staging LKE cluster ID"
  value       = module.lke.cluster_id
}

output "lke_api_endpoint" {
  description = "Staging Kubernetes API endpoint"
  value       = module.lke.api_endpoint
}

output "kubeconfig" {
  description = "Staging kubeconfig (base64-encoded) — use to set STAGING_KUBECONFIG secret"
  value       = module.lke.kubeconfig
  sensitive   = true
}
