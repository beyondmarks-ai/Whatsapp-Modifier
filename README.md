# WhatsApp Message Scheduler

A self-hosted, single-account WhatsApp scheduler built on Baileys and deployed to Azure App Service. It includes a responsive browser dashboard, synchronized chat selection, scheduled text messages, retry handling, and persistent authentication.

> [!CAUTION]
> This project uses WhatsApp Web through an unofficial client. It is not affiliated with or endorsed by WhatsApp. Use it only for consent-based personal or business messaging. Do not use it for spam, bulk messaging, scraping, surveillance, or restriction evasion.

## Features

- Browser dashboard for selecting a synchronized direct chat or group
- Local date/time scheduling with message status history
- Bearer-token authentication for every private endpoint
- Pairing-code login without Selenium or Chromium
- Persistent auth, chat metadata, and scheduled jobs in Azure's `/home` storage
- Atomic JSON writes and automatic recovery after process restarts
- Five send attempts with exponential retry delays
- HTTPS-only Azure App Service deployment wizard

## Architecture

```text
Browser dashboard
       | HTTPS + bearer token
       v
Azure App Service (Node.js)
       |-- Baileys WebSocket --> WhatsApp
       `-- /home/data/baileys-scheduler
             |-- auth/
             |-- chats.json
             `-- messages.json
```

The file-backed design intentionally supports one WhatsApp account on one App Service worker. Use a transactional database and centralized auth/key storage before enabling multiple workers or accounts.

## Requirements

- Node.js 20 or newer
- Yarn 4 through Corepack
- Azure CLI, Bash, and `curl` for Azure deployment
- A WhatsApp account that can link a companion device

## Run locally

```bash
corepack enable
yarn install
yarn build
export SCHEDULER_TOKEN="$(openssl rand -hex 32)"
yarn scheduler
```

PowerShell equivalent:

```powershell
corepack enable
yarn install
yarn build
$env:SCHEDULER_TOKEN = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
yarn scheduler
```

Open <http://localhost:3000>, enter the generated token, and pair the WhatsApp account through the API if it is not already linked.

Local state is written to `.scheduler-data/` and must never be committed.

## Deploy to Azure

Sign in to Azure CLI, then run the guided deployment:

```bash
az login
bash scripts/azure-scheduler-setup.sh
```

The wizard:

1. Confirms the active Azure subscription.
2. Creates or reuses one Linux B1 App Service plan and web app.
3. Generates a strong admin token.
4. Deploys with Yarn 4 and Node.js 24 LTS.
5. Enables HTTPS, Always On, persistent storage, and restricted logging.
6. Walks through WhatsApp pairing and an optional smoke test.

Azure values and the admin token are saved locally in the git-ignored `.env.azure` file. B1 is billable until its resource group is deleted; check current Azure pricing for your region.

After deployment, open the `APP_URL` recorded in `.env.azure`.

## Dashboard

1. Open the deployed URL.
2. Enter `SCHEDULER_TOKEN` from `.env.azure`. The browser keeps it only for the current tab session.
3. Search and select a synchronized chat.
4. Enter the message and local send date/time.
5. Select **Schedule message**.

WhatsApp sends initial chat history during a fresh companion-device link. If older chats are missing after adding the scheduler, reset and pair the companion session again so the chat directory can capture that initial sync.

## API

All endpoints except `/` and `/health` require:

```text
Authorization: Bearer <SCHEDULER_TOKEN>
```

| Method   | Path             | Purpose                                       |
| -------- | ---------------- | --------------------------------------------- |
| `GET`    | `/`              | Dashboard                                     |
| `GET`    | `/health`        | Service and WhatsApp connection status        |
| `POST`   | `/pair`          | Request a WhatsApp pairing code               |
| `POST`   | `/session/reset` | Log out and clear the saved companion session |
| `GET`    | `/chats`         | List synchronized direct chats and groups     |
| `POST`   | `/messages`      | Schedule a text message                       |
| `GET`    | `/messages`      | List scheduled-message records                |
| `DELETE` | `/messages/:id`  | Remove a scheduled-message record             |

### Pair

```bash
curl --fail --request POST "$APP_URL/pair" \
  --header "Authorization: Bearer $SCHEDULER_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"phone":"919876543210"}'
```

Phone numbers contain 7–15 digits including the country code, without `+`, spaces, or punctuation.

### Schedule by phone number

```bash
curl --fail --request POST "$APP_URL/messages" \
  --header "Authorization: Bearer $SCHEDULER_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"phone":"919876543210","text":"Hello","sendAt":"2026-09-08T10:30:00+05:30"}'
```

The dashboard schedules by a known chat JID instead, which also supports groups.

### List jobs

```bash
curl --fail "$APP_URL/messages" \
  --header "Authorization: Bearer $SCHEDULER_TOKEN"
```

### Remove a job

```bash
curl --fail --request DELETE "$APP_URL/messages/JOB_ID" \
  --header "Authorization: Bearer $SCHEDULER_TOKEN"
```

Deleting a record that is already sending cannot recall the WhatsApp message.

## Configuration

| Variable          | Required | Default           | Description                           |
| ----------------- | -------- | ----------------- | ------------------------------------- |
| `SCHEDULER_TOKEN` | Yes      | —                 | Admin bearer token, at least 32 bytes |
| `PORT`            | No       | `3000`            | HTTP listening port                   |
| `DATA_DIR`        | No       | `.scheduler-data` | Persistent state directory            |
| `LOG_LEVEL`       | No       | `info`            | Pino-compatible log level             |

## Security and delivery limits

- Never commit `.env.azure`, `.scheduler-data/`, or WhatsApp auth files. Auth state contains long-lived cryptographic keys.
- Keep SCM basic authentication disabled and rotate the admin token if it is exposed.
- Logs intentionally exclude chat names, phone numbers, and message text.
- `sent` means WhatsApp accepted the send operation; it is not a delivery receipt.
- Delivery is at-least-once. A crash immediately after WhatsApp accepts a message can cause a duplicate after recovery.
- Scheduled text is stored unencrypted in the App Service filesystem. Use database encryption when your data policy requires it.

## Development checks

```bash
yarn build
yarn tsc -p tsconfig.scheduler.json
yarn test:scheduler
yarn test
yarn lint
```

The repository requires Yarn 4. Do not regenerate `yarn.lock` with Yarn Classic.

## Operations

Stream Azure logs:

```bash
az webapp log tail --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_APP_NAME"
```

Delete the deployment and stop all charges:

```bash
az group delete --name "$AZURE_RESOURCE_GROUP"
```

## License

Distributed under the [MIT License](LICENSE). Existing copyright and package provenance are retained as required.

<!-- beyond-marks-credit:start -->
---
### Built by Beyond Marks AI Academy

Developed by **Rakesh Kumar** at [Beyond Marks AI Academy](https://beyondmarks.ai).
<!-- beyond-marks-credit:end -->
