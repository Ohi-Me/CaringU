# Deploying CaringU on AWS

> Status: deployed and checked on 2026-10-22: t4g.small (Graviton, arm64), Amazon Linux 2023, in us-east-1. Health, Bedrock (instance role, no keys on disk), OpenCV 5 and HTTPS through Caddy all verified.

The simplest path that needs no Docker: **one small EC2 instance**, with Caddy handling HTTPS through a free `sslip.io` hostname. The app is one Node process: the MCP server at `/mcp`, the agent API and the web client.

## 1. IAM role for the instance (Bedrock without keys)

IAM → Roles → Create role → trusted entity **EC2**. Add this inline policy:

```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":"arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0"}]}
```

Name it `caringu-ec2`.

## 2. Launch the instance

- Region **us-east-1**, AMI **Amazon Linux 2023 (arm64)**, type **`t4g.small`** (Graviton; cheaper, and arm64 is what the OpenCV COOL award looks for). x86 `t3.small` also works.
- Security group: inbound **80** and **443** from anywhere. SSH 22 only from your IP, if you need it.
- Advanced → IAM instance profile: `caringu-ec2`.
- Advanced → User data: paste [`deploy/ec2-user-data.sh`](../deploy/ec2-user-data.sh) (it already points at https://github.com/Ohi-Me/CaringU).

After 3–5 minutes, open `https://<public-ip-with-dashes>.sslip.io`. For example, IP 3.91.10.20 becomes `https://3-91-10-20.sslip.io`.

## 3. Notes

- **Cost:** a t3.small is a few cents per hour. Stop the instance when you aren't demoing; the data on disk survives a stop and start. Nova Pro calls cost fractions of a cent each.
- **Data** lives in `/opt/caringu/data/caringu.db`. "Reset demo" in the UI restores the sample data.
- **The app is public:** anyone with the URL can use the demo and reset it. It holds only sample data, but don't put real personal data on it.
- **Update:** `sudo -u caringu git -C /opt/caringu/app pull`, then rebuild `web/` and run `sudo systemctl restart caringu`.
- **Logs:** `journalctl -u caringu -f`.

## Alternative: App Runner (container)

The repo's [`Dockerfile`](../Dockerfile) builds a single image (port 8080). With Docker available: push it to ECR, create an App Runner service from the image with an instance role that has the policy above, and set `AGENT_MODE=bedrock`. The container's SQLite resets on each deploy.
