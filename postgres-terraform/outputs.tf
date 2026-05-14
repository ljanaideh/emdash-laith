output "rds_endpoint" {
  description = "RDS instance hostname"
  value       = aws_db_instance.emdash.address
}

output "rds_port" {
  description = "RDS port"
  value       = aws_db_instance.emdash.port
}

output "rds_db_name" {
  description = "Database name"
  value       = aws_db_instance.emdash.db_name
}

output "connection_string" {
  description = "DATABASE_URL for bootstrap script (uses master user — swap to emdash_app after setup)"
  value       = "postgres://${var.master_username}:PASSWORD@${aws_db_instance.emdash.address}:${aws_db_instance.emdash.port}/${var.db_name}?sslmode=require"
  sensitive   = false
}

output "hyperdrive_origin" {
  description = "Host to use when running: wrangler hyperdrive update <id> --origin-host <this>"
  value       = aws_db_instance.emdash.address
}

output "tunnel_instance_id" {
  description = "EC2 instance ID for the cloudflared tunnel"
  value       = aws_instance.tunnel.id
}

output "tunnel_ssm_connect" {
  description = "Command to open a shell on the tunnel EC2 (no SSH key needed)"
  value       = "aws ssm start-session --target ${aws_instance.tunnel.id} --region ${var.aws_region}"
}

output "post_provision_tunnel" {
  description = "Steps to complete the cloudflared tunnel setup after terraform apply"
  value       = <<-EOT

    ── Tunnel setup (run after terraform apply) ────────────────────────────

    1. Open a shell on the EC2 (no key pair needed — uses SSM):

         aws ssm start-session --target ${aws_instance.tunnel.id} --region ${var.aws_region}

    2. Authenticate cloudflared (opens a browser link — paste it locally):

         cloudflared tunnel login

    3. Create the tunnel and configure it to proxy to RDS:

         cloudflared tunnel create emdash-pg

         cat > /etc/cloudflared/config.yml << 'EOF'
         tunnel: <tunnel-id-from-step-above>
         credentials-file: /root/.cloudflared/<tunnel-id>.json
         ingress:
           - service: tcp://${aws_db_instance.emdash.address}:5432
         EOF

    4. Enable and start the service:

         systemctl enable --now cloudflared

    5. Update Hyperdrive to use the tunnel:

         wrangler hyperdrive update 01b192bf33194ecda6ad2aa1b2f2f8d2 \
           --origin-host <tunnel-id>.cfargotunnel.com \
           --origin-port 5432 \
           --database ${var.db_name} \
           --origin-user emdash_app

    6. Stop cloudflared on your laptop.

    ────────────────────────────────────────────────────────────────────────
  EOT
}

output "post_provision_steps" {
  description = "Reminder of manual steps after terraform apply"
  value       = <<-EOT

    ── Post-provision checklist ────────────────────────────────────────────

    1. Connect as master user and create the app user:

         psql "postgres://${var.master_username}:PASSWORD@${aws_db_instance.emdash.address}:5432/${var.db_name}?sslmode=require"

         CREATE USER emdash_app WITH PASSWORD 'your-app-password';
         GRANT CONNECT ON DATABASE ${var.db_name} TO emdash_app;
         GRANT CREATE ON SCHEMA public TO emdash_app;
         GRANT USAGE  ON SCHEMA public TO emdash_app;
         ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO emdash_app;
         ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO emdash_app;

    2. Update Cloudflare Hyperdrive to point at the new endpoint:

         wrangler hyperdrive update 01b192bf33194ecda6ad2aa1b2f2f8d2 \
           --origin-host ${aws_db_instance.emdash.address} \
           --origin-port 5432 \
           --database ${var.db_name} \
           --origin-user emdash_app

    3. Update DATABASE_URL in Cloudflare Pages env vars:

         postgres://emdash_app:PASSWORD@${aws_db_instance.emdash.address}:5432/${var.db_name}?sslmode=require

    4. Push a new commit to trigger the Pages build (which runs migrations).

    ────────────────────────────────────────────────────────────────────────
  EOT
}
