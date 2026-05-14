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

# ── Secrets ───────────────────────────────────────────────────────────────────
# Prerequisite: create the secret once before first terraform apply:
#   aws secretsmanager create-secret \
#     --name emdash/rds/master_password \
#     --secret-string 'yourpassword'

data "aws_secretsmanager_secret_version" "db_password" {
  secret_id = var.db_password_secret_name
}

# ── Networking ────────────────────────────────────────────────────────────────

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

# ── Security Group: Tunnel EC2 ────────────────────────────────────────────────
# cloudflared makes outbound connections to Cloudflare's network — no inbound needed.
# Shell access via SSM Session Manager (no open port 22).
# Defined before the rds SG so it can be referenced in rds ingress.

resource "aws_security_group" "tunnel" {
  name        = "${var.identifier}-tunnel"
  description = "cloudflared Hyperdrive tunnel - outbound only, SSM shell access"
  vpc_id      = data.aws_vpc.default.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.identifier}-tunnel"
    Project = "emdash"
  }
}

# ── Security Group: RDS ───────────────────────────────────────────────────────
# Private Hyperdrive via cloudflared tunnel — only the EC2 needs access to RDS.
# Cloudflare never connects directly to RDS; traffic flows through the tunnel.

resource "aws_security_group" "rds" {
  name_prefix = "${var.identifier}-rds-"
  description = "PostgreSQL access from cloudflared tunnel EC2 only"
  vpc_id      = data.aws_vpc.default.id

  ingress {
    description     = "PostgreSQL - cloudflared tunnel EC2"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.tunnel.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name    = "${var.identifier}-rds"
    Project = "emdash"
  }
}

# ── Security Group: RDS Open ──────────────────────────────────────────────────
# Port 5432 open to all — for direct psql admin access.
# Detach from RDS when not needed.

resource "aws_security_group" "rds_open" {
  name        = "${var.identifier}-rds-open"
  description = "PostgreSQL open access - attach only for admin/dev use"
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

# ── IAM: SSM access for tunnel EC2 ───────────────────────────────────────────

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "tunnel" {
  name               = "${var.identifier}-tunnel"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json

  tags = {
    Name    = "${var.identifier}-tunnel"
    Project = "emdash"
  }
}

resource "aws_iam_role_policy_attachment" "tunnel_ssm" {
  role       = aws_iam_role.tunnel.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "tunnel" {
  name = "${var.identifier}-tunnel"
  role = aws_iam_role.tunnel.name
}

# ── AMI: Amazon Linux 2023 ───────────────────────────────────────────────────

data "aws_ami" "al2023" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-2023.*-x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# ── EC2: cloudflared tunnel instance ─────────────────────────────────────────
# Runs cloudflared to provide the private Hyperdrive tunnel.
# No inbound ports — connect via: aws ssm start-session --target <instance-id>
# After provisioning, follow the post_provision_tunnel output to finish setup.

resource "aws_instance" "tunnel" {
  ami                    = data.aws_ami.al2023.id
  instance_type          = var.tunnel_instance_class
  subnet_id              = tolist(data.aws_subnets.default.ids)[0]
  vpc_security_group_ids = [aws_security_group.tunnel.id]
  iam_instance_profile   = aws_iam_instance_profile.tunnel.name

  user_data = <<-EOF
    #!/bin/bash
    set -euo pipefail

    # Install cloudflared binary
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
      -o /usr/local/bin/cloudflared
    chmod +x /usr/local/bin/cloudflared

    mkdir -p /etc/cloudflared

    # Systemd unit — credentials are placed after post-provision steps
    cat > /etc/systemd/system/cloudflared.service << 'UNIT'
    [Unit]
    Description=Cloudflare Tunnel (Hyperdrive -> RDS)
    After=network-online.target
    Wants=network-online.target

    [Service]
    Type=simple
    User=root
    ExecStart=/usr/local/bin/cloudflared tunnel --config /etc/cloudflared/config.yml run
    Restart=on-failure
    RestartSec=5s

    [Install]
    WantedBy=multi-user.target
    UNIT

    systemctl daemon-reload
    # Do not enable yet — run post-provision tunnel steps first
  EOF

  tags = {
    Name    = "${var.identifier}-tunnel"
    Project = "emdash"
  }
}

# ── RDS Instance ──────────────────────────────────────────────────────────────

resource "aws_db_instance" "emdash" {
  identifier = var.identifier

  engine         = "postgres"
  engine_version = var.postgres_version
  instance_class = var.instance_class

  db_name  = var.db_name
  username = var.master_username
  password = data.aws_secretsmanager_secret_version.db_password.secret_string
  port     = 5432

  allocated_storage = var.allocated_storage
  storage_type      = "gp3"
  storage_encrypted = true

  publicly_accessible = true

  db_subnet_group_name   = aws_db_subnet_group.emdash.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  backup_retention_period = 7
  deletion_protection     = false

  skip_final_snapshot = true

  tags = {
    Name    = var.identifier
    Project = "emdash"
  }
}
