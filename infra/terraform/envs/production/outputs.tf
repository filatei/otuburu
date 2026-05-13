output "vpc_id" {
  description = "Production VPC ID"
  value       = module.vpc.vpc_id
}

output "lke_cluster_id" {
  description = "Production LKE cluster ID"
  value       = module.lke.cluster_id
}

output "lke_api_endpoint" {
  description = "Production Kubernetes API endpoint"
  value       = module.lke.api_endpoint
}

output "kubeconfig" {
  description = "Production kubeconfig (base64-encoded)"
  value       = module.lke.kubeconfig
  sensitive   = true
}

output "storage_buckets" {
  description = "Object Storage bucket names"
  value       = module.storage.bucket_names
}
