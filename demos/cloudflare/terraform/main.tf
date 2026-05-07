terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
  required_version = ">= 1.5"
}

provider "aws" {
  region = var.aws_region
}

# ── Networking ──────────────────────────────────────────────────────────────

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_db_subnet_group" "emdash" {
  name       = "${var.identifier}-subnet-group"
  subnet_ids = data.aws_subnets.default.ids

  tags = {
    Name    = "${var.identifier}-subnet-group"
    Project = "emdash"
  }
}

# ── Security Group: RDS Cloudflare ───────────────────────────────────────────
# Port 5432 restricted to Cloudflare egress IPs — always attached to RDS.
# IP list: https://www.cloudflare.com/ips/

resource "aws_security_group" "rds" {
  name        = "${var.identifier}-rds-cloudflare"
  description = "PostgreSQL access for Cloudflare Hyperdrive egress IPs"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "PostgreSQL - Cloudflare egress IPs"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [
      "173.245.48.0/20",
      "103.21.244.0/22",
      "103.22.200.0/22",
      "103.31.4.0/22",
      "141.101.64.0/18",
      "108.162.192.0/18",
      "190.93.240.0/20",
      "188.114.96.0/20",
      "197.234.240.0/22",
      "198.41.128.0/17",
      "162.158.0.0/15",
      "104.16.0.0/13",
      "104.24.0.0/14",
      "172.64.0.0/13",
      "131.0.72.0/22",
    ]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.identifier}-rds-cloudflare"
    Project = "emdash"
  }
}

# ── Security Group: RDS Open ──────────────────────────────────────────────────
# Port 5432 open to all — for direct psql admin access.
# Detach from RDS when not needed.

resource "aws_security_group" "rds_open" {
  name        = "${var.identifier}-rds-open"
  description = "PostgreSQL open access — attach only for admin/dev use"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description = "PostgreSQL - open access"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.identifier}-rds-open"
    Project = "emdash"
  }
}

# ── RDS Instance ─────────────────────────────────────────────────────────────

resource "aws_db_instance" "emdash" {
  identifier = var.identifier

  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.instance_class

  # Creates the emdash_dev database at provision time
  db_name  = var.db_name
  username = var.master_username
  password = var.master_password
  port     = 5432

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  # Must be true for Cloudflare Hyperdrive to reach the instance
  publicly_accessible = true

  db_subnet_group_name   = aws_db_subnet_group.emdash.name
  vpc_security_group_ids = [aws_security_group.rds.id, aws_security_group.rds_open.id]

  backup_retention_period = 7
  deletion_protection     = false

  # For a dev/demo instance — skip the final snapshot on destroy
  skip_final_snapshot = true

  tags = {
    Name    = var.identifier
    Project = "emdash"
  }
}
