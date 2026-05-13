variable "name_prefix" {
  type = string
}

variable "region" {
  type = string
}

variable "environment" {
  type = string
}

variable "k8s_version" {
  type    = string
  default = "1.31"
}

variable "node_type" {
  type    = string
  default = "g6-standard-2"
}

variable "node_count" {
  type    = number
  default = 3
}

variable "tags" {
  type    = list(string)
  default = []
}
