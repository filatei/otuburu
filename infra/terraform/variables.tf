variable "linode_token" {
  description = "Linode API token (use TF_VAR_linode_token env var — never commit this)"
  type        = string
  sensitive   = true
}

variable "region" {
  description = "Linode region"
  type        = string
  default     = "us-east"
}

variable "environment" {
  description = "Deployment environment (staging | production)"
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production"
  }
}

variable "lke_k8s_version" {
  description = "Kubernetes version for the LKE cluster"
  type        = string
  default     = "1.31"
}

variable "lke_node_type" {
  description = "Linode instance type for LKE worker nodes"
  type        = string
  default     = "g6-standard-2"   # 2 vCPU / 4 GB RAM
}

variable "lke_node_count" {
  description = "Number of LKE worker nodes"
  type        = number
  default     = 3
}

variable "db_password" {
  description = "Postgres database password"
  type        = string
  sensitive   = true
}

variable "tags" {
  description = "Common resource tags"
  type        = list(string)
  default     = ["otuburu", "torama-money"]
}
