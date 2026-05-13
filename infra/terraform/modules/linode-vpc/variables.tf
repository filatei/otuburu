variable "name_prefix"          { type = string }
variable "region"               { type = string }
variable "environment"          { type = string }
variable "private_subnet_cidr"  { type = string; default = "10.0.1.0/24" }
