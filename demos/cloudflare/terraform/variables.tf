variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "identifier" {
  description = "RDS instance identifier (also used as prefix for security group / subnet group names)"
  type        = string
  default     = "emdash-demo"
}

variable "postgres_version" {
  description = "PostgreSQL engine version. Check available versions with: aws rds describe-db-engine-versions --engine postgres --query 'DBEngineVersions[*].EngineVersion'"
  type        = string
  default     = "18.3"
}

variable "instance_class" {
  description = "RDS instance type"
  type        = string
  default     = "db.t3.micro"
}

variable "allocated_storage" {
  description = "Allocated storage in GB"
  type        = number
  default     = 20
}

variable "db_name" {
  description = "Name of the initial database to create"
  type        = string
  default     = "emdash_dev"
}

variable "master_username" {
  description = "Master DB username"
  type        = string
  default     = "postgres"
}

variable "master_password" {
  description = "Master DB password — set via TF_VAR_master_password or terraform.tfvars"
  type        = string
  sensitive   = true
}
