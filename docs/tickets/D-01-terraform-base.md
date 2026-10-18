# D-01 — Terraform base infrastructure

| Field | Value |
|---|---|
| Phase / lane | D / B |
| Risk tier | 1 |
| Depends on | — (P0-04 for repo conventions) |
| Replaces old | M14-T01, M14-T02, M14-T03, M14-T07 (repo), M14-T15, M0-T06 (topology record) |
| Status | todo |

> **Milestone D ([ADR-0013](../adr/0013-local-first-deployment-milestone.md)).** This was the first draft's
> P1-08, moved out of the local weeks (P1-08 is now the production-like local stack). It stays detailed, but
> re-frame it before starting: the code it builds on will have changed by then.

## Goal

One `terraform apply` creates the staging environment's AWS resources in `ca-central-1`, with least-privilege
roles and no long-lived AWS keys anywhere.

## Why

Reproducible infrastructure means production at pilot time is "the same code, a new workspace", not a
weekend of console clicking ([ADR-0008](../adr/0008-single-ec2-compose-caddy.md)).

## Scope

- **Prerequisites** (humans). Start these about a week before milestone D (by default, during week 8):
  the domain, DNS and SES DKIM verification involve real waiting time.
  - an AWS account with MFA on root
  - an admin IAM Identity Center user
  - a domain name (for example via Route 53, about $15/year)
  - budget alerts email
- In (`infra/terraform/`, Terraform ≥ 1.10 or OpenTofu ≥ 1.10):
  - **`bootstrap/`:** S3 state bucket (versioned, encrypted, Block Public Access), using S3 native state
    locking (`use_lockfile = true`).
  - **`envs/staging/`** calling `modules/app_env` with these resources:
    - **Network:** default VPC data sources, or a minimal VPC with one public subnet. Security group:
      ingress 80/443 IPv4/IPv6 only, no 22; egress all.
    - **EC2:**
      - `t3a.small`, Ubuntu 24.04 AMI resolved from the Canonical SSM public parameter
      - IMDSv2 required
      - 20 GiB encrypted gp3 root
      - user-data from D-02 (template placeholder for now)
    - **Data volume:** 30 GiB encrypted gp3 EBS plus its attachment. Prevent destroy with
      `lifecycle { prevent_destroy = true }`.
    - **Elastic IP.** DNS A/AAAA records go in Route 53 if the domain is hosted there; otherwise they are
      outputs to add at the registrar.
    - **IAM instance role:**
      - `AmazonSSMManagedInstanceCore`
      - ECR pull for the repo
      - S3 read/write on the files bucket, including `s3:ListBucket` on it: without it a HEAD on a key not yet
        uploaded returns 403 instead of 404, and `POST /files/{id}/complete` answers 500 instead of 409
        `upload_incomplete` (P3-04a, PR #70 follow-up)
      - S3 put/get/list on backups and artifacts
      - `ssm:GetParameters*` on `/condo/staging/*` plus KMS decrypt for `aws/ssm`
      - CloudWatch Logs create/put on `/condo/staging/*`
    - **ECR repo `condo-api`:** immutable tags, scan on push, lifecycle keeping 30 images.
    - **S3 buckets:**
      - `files`: Block Public Access, versioning, SSE-S3, CORS for `https://<domain>` POST/GET, lifecycle on
        noncurrent versions after 30 days
      - `backups`: Block Public Access, versioning, SSE-S3, lifecycle 30 days
      - `artifacts`: frontend tarballs, 30 days
    - **GitHub OIDC** provider and a deploy role:
      - trust limited to `repo:<owner>/building-website:ref:refs/heads/main` and the `environment:staging`
        claim
      - permissions: ECR push, artifacts put, `ssm:SendCommand` for `AWS-RunShellScript` on instances tagged
        `env=staging`, `ssm:GetCommandInvocation`
    - **SES:** domain identity, DKIM and a MAIL FROM domain, with records in Route 53 or as outputs. The
      account starts in the sandbox, which is fine for staging.
    - **SSM parameters** as **placeholders** only: `SECRET_KEY`, `SMTP_USER`, `SMTP_PASSWORD`, `SENTRY_DSN`.
      Real values are set by humans with `aws ssm put-parameter --overwrite`, never in `.tfvars` or state.
    - **CloudWatch log groups** `/condo/staging/{api,worker,caddy}` with 30-day retention.
    - **Budget** alarms at $30 and $40 per month, emailing James.
  - Outputs: instance id, EIP, domain, bucket names, ECR URL, deploy role ARN.
  - **CI:** a `terraform fmt -check` and `terraform validate` job (plus `tflint` optional) on changes under
    `infra/`.
- Out:
  - production environment (pilot)
  - host software (D-02)
  - deploy pipeline (D-03)

## Interfaces

Variables: `env`, `domain`, `github_repo`, `alert_emails`, `instance_type`. Tags: `project=condo`,
`env=staging`.

## Acceptance criteria

1. **Given** fresh credentials, **when** `bootstrap` then `envs/staging` are applied, **then** all resources
   exist, and a second `plan` shows no changes.
2. **Given** the instance, **when** connecting with `aws ssm start-session`, **then** a shell opens. A port
   scan shows only 80/443 open.
3. **Given** the instance role, **when** listing a bucket other than its own from the instance, **then**
   AccessDenied.
4. **Given** the repo, **then** no AWS access keys exist in GitHub secrets, and the deploy role's trust policy
   rejects a token from another branch (check with `aws iam simulate-…`, or by reasoning documented in the PR).
5. **Given** `terraform destroy -target` on the instance, **then** the data volume survives
   (`prevent_destroy` on the volume; the instance can be replaced).

## Test plan

`terraform fmt -check -recursive`, `terraform validate`, `terraform plan` (attach a summary to the PR).
Manual steps for criteria 2–5, with the commands recorded in the PR.

## Likely files

`infra/terraform/bootstrap/*.tf`, `infra/terraform/modules/app_env/*.tf`, `infra/terraform/envs/staging/*.tf`,
`infra/README.md`, `.github/workflows/infra.yml`.

## Must explain (learning checkpoint)

1. How does GitHub OIDC let Actions assume an AWS role without stored keys? What does the `sub` claim
   restriction protect against?
2. Why IMDSv2, and why no port 22?
3. Why is the database on a separate EBS volume with `prevent_destroy`?
4. Why must secret values never go into Terraform variables or state?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
