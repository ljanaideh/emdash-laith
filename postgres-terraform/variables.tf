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

variable "tunnel_instance_class" {
  description = "EC2 instance type for the cloudflared tunnel"
  type        = string
  default     = "t3.micro"
}

variable "db_password_secret_name" {
  description = "AWS Secrets Manager secret name that holds the RDS master password. Create it once with: aws secretsmanager create-secret --name emdash/rds/master_password --secret-string 'yourpassword'"
  type        = string
  default     = "emdash/rds/master_password"
}
