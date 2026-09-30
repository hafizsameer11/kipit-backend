# Expo push notifications setup

## What was built

- **App:** requests permission, gets Expo push token, registers with `POST /v1/settings/push-token`
- **API:** stores tokens in `PushDevice`, sends via Expo Push API when creating notifications (`notifyCustomer`, KYC job, maturity)
- **Prefs:** existing `pushDeposits` / `pushWithdrawals` / … toggles are respected

## Firebase service account (you added)

File lives at `kipit-api/secrets/firebase-service-account.json` (gitignored).

This is the **FCM V1** credential Expo needs for Android delivery.

### Upload to EAS (one-time)

```bash
cd KipitApp
npx eas login
npx eas credentials -p android
```

Select FCM V1 / Google Service Account → upload `../kipit-api/secrets/firebase-service-account.json`.

For iOS, configure Push Notifications in EAS credentials with your Apple Developer account.

## Database

```bash
cd kipit-api
npx prisma migrate deploy
```

## Build a real client

Push needs a device build (dev/preview/production), not Expo Go alone for reliable Android FCM:

```bash
cd KipitApp
npx eas build -p android --profile preview
```

## Optional env

`EXPO_ACCESS_TOKEN` — Expo access token for higher push rate limits.
