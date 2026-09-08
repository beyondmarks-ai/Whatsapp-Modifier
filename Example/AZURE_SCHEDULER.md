# Azure message scheduler

This example runs one Baileys account continuously on Azure App Service and stores its auth state and scheduled text messages in App Service's persistent `/home` directory.

It is intended for consent-based, individual messaging. It does not implement bulk sending or restriction evasion.

## Deploy

Prerequisites: Azure CLI, Node.js 20 or newer, Bash, and `curl`.

```bash
bash scripts/azure-scheduler-setup.sh
```

The wizard confirms the Azure subscription and estimated B1 cost before creating anything billable. It writes resource names and the generated admin token to the git-ignored `.env.azure` file, deploys the app, walks through WhatsApp pairing, and offers a smoke test.

Open `APP_URL` in a browser and enter the admin token from `.env.azure`. The dashboard lists chats synchronized by the linked WhatsApp account and schedules messages using your browser's local time zone. The token is kept in session storage and is cleared when you close the tab.

## API

Load the deployment values before using these commands:

```bash
set -a
source .env.azure
set +a
```

Schedule a text message using an ISO-8601 timestamp with an explicit timezone:

```bash
curl --fail --request POST "$APP_URL/messages" \
  --header "Authorization: Bearer $SCHEDULER_TOKEN" \
  --header 'Content-Type: application/json' \
  --data '{"phone":"919876543210","text":"Hello","sendAt":"2026-09-08T10:30:00+05:30"}'
```

List jobs:

```bash
curl --fail "$APP_URL/messages" \
  --header "Authorization: Bearer $SCHEDULER_TOKEN"
```

Cancel or remove a job:

```bash
curl --fail --request DELETE "$APP_URL/messages/JOB_ID" \
  --header "Authorization: Bearer $SCHEDULER_TOKEN"
```

## Operations

Stream logs without exposing message text or phone numbers:

```bash
az webapp log tail --resource-group "$AZURE_RESOURCE_GROUP" --name "$AZURE_APP_NAME"
```

Delete the deployment and stop all charges:

```bash
az group delete --name "$AZURE_RESOURCE_GROUP"
```

The scheduler retries failures up to five times. Delivery is at-least-once: a process failure immediately after WhatsApp accepts a message can result in a duplicate. Exactly-once delivery would require server-side idempotency that WhatsApp Web does not provide.

This example deliberately uses `useMultiFileAuthState` for a single bot-like account. For multiple accounts or scaled-out instances, replace both file stores with a transactional database-backed implementation before scaling beyond one worker.
