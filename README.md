# Kipit API

Express + Prisma + PostgreSQL + Redis backend for Kipit (mobile, web, admin, Ask AI).

## Quick start

```bash
cd kipit-api
docker compose up -d
npm install
npx prisma db push
npm run db:seed
npm run dev
```

API: `http://localhost:4000` · Worker: `npm run worker`

Dev OTP is always `123456`. Demo BVN: `22123456789`.

### Seeded accounts

| Surface | Email | Password |
|---------|-------|----------|
| Consumer | `adaeze.okonkwo@gmail.com` | `Kipit1234!` (PIN `2468`) |
| Admin | `seyi.adeleke@kipit.com` | `Kipit1234!` |
| Admin checker | `ops@kipit.com` | `Kipit1234!` |

## Endpoint map

### Auth `/v1/auth`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/register` | no | Create user + wallet + signup OTP |
| POST | `/otp/request` | no | Request OTP |
| POST | `/otp/verify` | no | Verify OTP |
| POST | `/login` | no | Email/password → tokens |
| POST | `/pin` | yes | Set transaction PIN |
| GET | `/me` | yes | Current user + wallet |
| GET | `/sessions` | yes | Active sessions |
| DELETE | `/sessions/:id` | yes | Revoke session |
| POST | `/logout` | yes | Revoke current session |
| POST | `/dev/session` | no (dev) | Issue session by userId |

### Wallet `/v1/wallet`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | yes | Balance |
| POST | `/sandbox/deposit` | yes | Sandbox credit (idempotent) |

### Me / home
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/v1/me/home` | yes | Home summary |
| GET | `/v1/home/feed` | yes | Feed cards |

### KYC `/v1/kyc`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | yes | Status |
| POST | `/bvn` | yes | Submit BVN |
| POST | `/bvn/confirm` | yes | Confirm match → Tier 1 |
| POST | `/tier2` | yes | Submit Tier 2 |

### Invest `/v1/invest`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/rates` | no | Rate bands |
| GET | `/call` | yes | Call balance |
| POST | `/call/deposit` | yes + T1 | Wallet → Call |
| POST | `/call/withdraw` | yes + T1 | Call → Wallet |
| POST | `/calculator` | no | Projected payout |
| POST | `/fixed-plans` | yes + T1 | Create fixed plan |
| GET | `/placements` | yes | List placements |
| GET/POST | `/auto-invest` | yes | Auto-invest rules |

### Explore `/v1/explore`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/categories` | no | Categories |
| GET | `/products` | no | Products |
| GET | `/products/:slug` | no | Product detail |
| POST | `/products/:slug/subscribe` | yes + T1 | Subscribe |
| POST | `/gifts` | yes + T1 | Create gift |

### Withdraw `/v1/withdraw`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/banks` | yes | Bank list |
| GET/POST | `/accounts` | yes + T2 | Payout accounts |
| POST | `/` | yes + T2 | Request withdrawal |
| GET | `/` | yes | List withdrawals |
| GET | `/:id` | yes | Withdrawal detail |

### Portfolio `/v1/portfolio`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/` | yes | Summary + holdings |
| GET | `/holdings/:id` | yes | Holding detail |
| GET | `/maturities` | yes | Upcoming maturities |
| GET | `/transactions` | yes | Ledger history |
| GET | `/transactions/:id` | yes | Transaction detail |

### Settings `/v1/settings`
Profile, address, PIN change, sessions, notifications, learn articles, terms.

### Chat `/v1/chat`
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| POST | `/message` | yes | Ask AI (read tools + handoff; never moves money) |

### Admin `/v1/admin`
Login, dashboard, users, KYC queue, withdrawals, rates (maker-checker), audit, jobs.

Dev-only: `POST /v1/admin/jobs/maturity/run`

## Payments (Monnify + Paystack)

Default: **sandbox mock** (`PAYMENTS_MODE=sandbox`, `PAYMENTS_MOCK=true`) — funding works without any provider keys.

| Flow | Provider | Endpoints |
|------|----------|-----------|
| Bank transfer VA | Monnify | `GET /v1/wallet/virtual-account`, `POST /v1/wallet/fund/transfer/confirm`, webhook `POST /v1/webhooks/monnify` |
| Card | Paystack | `POST /v1/wallet/fund/card/initialize`, `POST /v1/wallet/fund/card/confirm`, webhook `POST /v1/webhooks/paystack` |
| Withdrawal payout | Paystack transfer | Admin `POST /v1/admin/withdrawals/:id/complete` |

### Going live on the server

1. Set `PAYMENTS_MODE=live` and `PAYMENTS_MOCK=false`
2. Fill `MONNIFY_*` and `PAYSTACK_*` with **live** keys
3. Point Monnify/Paystack webhook URLs to `https://your-api/v1/webhooks/monnify` and `/paystack`
4. Set `APP_BASE_URL` and `WEB_APP_URL` to production URLs

Until then, leave mock on — the UI journeys credit wallets end-to-end.

## Client wiring

Web (`web-kipitapp`) and admin (`kipit-admin`) use `VITE_API_URL` (default `http://localhost:4000`).
Mobile (`KipitApp`) uses `EXPO_PUBLIC_API_URL`. UI screens are unchanged — only data/session layers call the API.
