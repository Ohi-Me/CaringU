# Deploying CareCircle on AWS

> Status: the script below was written for Amazon Linux 2023 but **has not been run yet**. Check each step on the first deploy and update this note.

The simplest path that needs no Docker: **one small EC2 instance**, with Caddy handling HTTPS through a free `sslip.io` hostname. The app is one Node process: the MCP server at `/mcp`, the agent API and the web client.

## 1. IAM role for the instance (Bedrock without keys)

IAM → Roles → Create role → trusted entity **EC2**. Add this inline policy:

```json
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":"arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0"}]}
```

Name it `carecircle-ec2`.

## 2. Launch the instance

- Region **us-east-1**, AMI **Amazon Linux 2023**, type `t3.small` or `t4g.small`.
- Security group: inbound **80** and **443** from anywhere. SSH 22 only from your IP, if you need it.
- Advanced → IAM instance profile: `carecircle-ec2`.
- Advanced → User data: paste [`deploy/ec2-user-data.sh`](../deploy/ec2-user-data.sh), after setting `REPO_URL` to the public GitHub repo.

After 3–5 minutes, open `https://<public-ip-with-dashes>.sslip.io`. For example, IP 3.91.10.20 becomes `https://3-91-10-20.sslip.io`.

## 3. Notes

- **Cost:** a t3.small is a few cents per hour. Stop the instance when you aren't demoing; the data on disk survives a stop and start. Nova Pro calls cost fractions of a cent each.
- **Data** lives in `/opt/carecircle/data/carecircle.db`. "Reset demo" in the UI restores the sample data.
- **The app is public:** anyone with the URL can use the demo and reset it. It holds only sample data, but don't put real personal data on it.
- **Update:** `sudo -u carecircle git -C /opt/carecircle/app pull`, then rebuild `web/` and run `sudo systemctl restart carecircle`.
- **Logs:** `journalctl -u carecircle -f`.

## Alternative: App Runner (container)

The repo's [`Dockerfile`](../Dockerfile) builds a single image (port 8080). With Docker available: push it to ECR, create an App Runner service from the image with an instance role that has the policy above, and set `AGENT_MODE=bedrock`. The container's SQLite resets on each deploy.
