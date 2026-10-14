# Kipit database

**Engine:** PostgreSQL  
**ORM:** Prisma (`kipit-api/prisma/schema.prisma`)  
**Connection:** `DATABASE_URL`

Money is stored as **kobo** (`BigInt`). IDs are **cuid** strings unless noted (`AppConfig.key` is a string PK).  
Delete rule: customer children usually **cascade** when the `User` is deleted. Ticket assignee uses **SetNull**. `JournalLine` → `LedgerAccount` does **not** cascade (account must stay while lines exist).

---

## How tables relate (cardinality)

| From | To | Relation | FK / unique | On delete |
|---|---|---|---|---|
| `User` | `Session` | 1 → many | `Session.userId` | Cascade |
| `User` | `OtpChallenge` | 1 → many (optional user) | `OtpChallenge.userId` nullable | Cascade |
| `User` | `KycProfile` | 1 → 0..1 | `KycProfile.userId` **unique** | Cascade |
| `User` | `NotificationPref` | 1 → 0..1 | `NotificationPref.userId` **unique** | Cascade |
| `User` | `LedgerAccount` | 1 → many | `LedgerAccount.userId` nullable (system accounts have none) | Cascade |
| `User` | `Placement` | 1 → many | `Placement.userId` | Cascade |
| `User` | `PayoutBank` | 1 → many | `PayoutBank.userId` | Cascade |
| `User` | `CardToken` | 1 → many | `CardToken.userId` | Cascade |
| `User` | `PaymentIntent` | 1 → many | `PaymentIntent.userId` | Cascade |
| `User` | `WithdrawalRequest` | 1 → many | `WithdrawalRequest.userId` | Cascade |
| `User` | `Gift` (sent) | 1 → many | `Gift.senderId` | Restrict (no cascade on sender) |
| `User` | `Gift` (received) | 1 → many | `Gift.recipientId` nullable | Restrict |
| `User` | `Notification` | 1 → many | `Notification.userId` | Cascade |
| `User` | `PushDevice` | 1 → many | `PushDevice.userId` | Cascade |
| `User` | `SupportTicket` | 1 → many | `SupportTicket.userId` | Cascade |
| `User` | `ChatSession` | 1 → many | `ChatSession.userId` | Cascade |
| `User` | `AutoInvestRule` | 1 → many | `AutoInvestRule.userId` | Cascade |
| `User` | `ConsentAcceptance` | 1 → many | `ConsentAcceptance.userId` | Cascade |
| `User` | `FeedCardView` | 1 → many | `FeedCardView.userId` | Cascade |
| `User` | `AuditEvent` | 1 → many | `AuditEvent.actorUserId` nullable | Restrict |
| `PayoutBank` | `WithdrawalRequest` | 1 → many | `WithdrawalRequest.payoutBankId` | Restrict |
| `ProductCategory` | `Product` | 1 → many | `Product.categoryId` | Restrict |
| `Product` | `Placement` | 1 → many | `Placement.productId` nullable | Restrict |
| `Product` | `ProductAccessRequest` | 1 → many | `ProductAccessRequest.productId` | Restrict |
| `Placement` | `Gift` | 1 → many | `Gift.placementId` nullable | Restrict |
| `RateBand` | `RateChangeRequest` | 1 → many | `RateChangeRequest.bandId` | Restrict |
| `LedgerAccount` | `JournalLine` | 1 → many | `JournalLine.accountId` | Restrict |
| `JournalEntry` | `JournalLine` | 1 → many | `JournalLine.entryId` | Cascade |
| `SupportTicket` | `SupportTicketMessage` | 1 → many | `SupportTicketMessage.ticketId` | Cascade |
| `AdminUser` | `AdminSession` | 1 → many | `AdminSession.adminId` | Cascade |
| `AdminUser` | `SupportTicket` | 1 → many (assignee) | `SupportTicket.assigneeAdminId` nullable | SetNull |
| `ChatSession` | `ChatMessage` | 1 → many | `ChatMessage.sessionId` | Cascade |
| `FeedCard` | `FeedCardView` | 1 → many | `FeedCardView.cardId` | Cascade |

**No FK (standalone / loosely linked)**

| Table | Linked by | Notes |
|---|---|---|
| `Placement.ledgerAccountId` | string, not a Prisma relation | Should match a `LedgerAccount` of type `USER_PLACEMENT` |
| `User.referredBy` | string, not a Prisma relation | Other user’s `referralCode` |
| `User.onboardedByAdminId` | string, not a Prisma relation | Admin who created the account |
| `KycProfile.reviewedByAdminId` | string | Reviewing admin |
| `RateChangeRequest.makerAdminId` / `checkerAdminId` | strings | Admin maker-checker |
| `WithdrawalRequest.processedByAdminId` | string | Admin who approved/declined |
| `AppConfig.updatedBy` | string | Admin id |
| `AuditEvent.actorAdminId` | string, not a Prisma relation | Admin actor |
| `JobRun`, `SignupFunnelEvent`, `LearnArticle` | — | No parent table |

---

## Full relation diagram

```mermaid
erDiagram
  User ||--o{ Session : userId
  User ||--o{ OtpChallenge : userId
  User ||--o| KycProfile : userId
  User ||--o| NotificationPref : userId
  User ||--o{ PushDevice : userId
  User ||--o{ ConsentAcceptance : userId
  User ||--o{ LedgerAccount : userId
  User ||--o{ Placement : userId
  User ||--o{ PayoutBank : userId
  User ||--o{ CardToken : userId
  User ||--o{ PaymentIntent : userId
  User ||--o{ WithdrawalRequest : userId
  User ||--o{ Gift : senderId
  User ||--o{ Gift : recipientId
  User ||--o{ Notification : userId
  User ||--o{ SupportTicket : userId
  User ||--o{ ChatSession : userId
  User ||--o{ AutoInvestRule : userId
  User ||--o{ FeedCardView : userId
  User ||--o{ AuditEvent : actorUserId

  PayoutBank ||--o{ WithdrawalRequest : payoutBankId
  ProductCategory ||--o{ Product : categoryId
  Product ||--o{ Placement : productId
  Product ||--o{ ProductAccessRequest : productId
  Placement ||--o{ Gift : placementId
  RateBand ||--o{ RateChangeRequest : bandId

  LedgerAccount ||--o{ JournalLine : accountId
  JournalEntry ||--o{ JournalLine : entryId

  AdminUser ||--o{ AdminSession : adminId
  AdminUser ||--o{ SupportTicket : assigneeAdminId
  SupportTicket ||--o{ SupportTicketMessage : ticketId
  ChatSession ||--o{ ChatMessage : sessionId
  FeedCard ||--o{ FeedCardView : cardId
```

```mermaid
flowchart TB
  subgraph Identity
    User
    Session
    OtpChallenge
    AdminUser
    AdminSession
  end

  subgraph Compliance
    KycProfile
    ConsentAcceptance
    AuditEvent
  end

  subgraph Money
    LedgerAccount
    JournalEntry
    JournalLine
    PaymentIntent
    WithdrawalRequest
    PayoutBank
    CardToken
  end

  subgraph Invest
    RateBand
    RateChangeRequest
    ProductCategory
    Product
    Placement
    AutoInvestRule
    Gift
  end

  subgraph Comms
    Notification
    NotificationPref
    PushDevice
    SupportTicket
    ChatSession
    FeedCard
    LearnArticle
  end

  subgraph Ops
    AppConfig
    JobRun
    SignupFunnelEvent
  end

  User --> Session
  User --> KycProfile
  User --> LedgerAccount
  User --> Placement
  User --> WithdrawalRequest
  User --> Notification
  User --> SupportTicket
  Placement --> Product
  JournalLine --> LedgerAccount
  JournalLine --> JournalEntry
  AdminUser --> AdminSession
```

---

## Schema by domain

### 1. Users, auth, KYC

A customer is one `User`. Login uses hashed password + OTP + refresh `Session`. KYC lives on `KycProfile` (exactly one row when started). Admins are **`AdminUser`**, not customers.

```mermaid
erDiagram
  User ||--o{ Session : has
  User ||--o{ OtpChallenge : has
  User ||--o| KycProfile : has
  User ||--o{ ConsentAcceptance : accepts
  User ||--o{ PushDevice : registers
  AdminUser ||--o{ AdminSession : has
```

**`User`** — customer account.

| Column | Type | Meaning |
|---|---|---|
| `id` | cuid PK | |
| `email`, `phone` | unique, optional | Login identifiers |
| `passwordHash`, `pinHash` | string | Auth + transaction PIN |
| `firstName`, `middleName`, `surname` | | Legal name |
| `accountType` | `PERSONAL` \| `BUSINESS` | |
| `businessName`, `businessRcNumber` | | Business KYC extras |
| `kycTier` | `TIER_0` / `_1` / `_2` | Cached tier (profile has the case) |
| `referralCode` | unique | Their invite code |
| `referredBy` | string | Other user’s code (logical, not FK) |
| `frozen`, `frozenReason` | | Admin freeze |
| `failedLoginCount`, `lockedUntil` | | Lockout |
| `monnifyAccountNo`, `monnifyBankName` | | Virtual account for transfers |
| `biometricsLogin`, `biometricsTxn` | bool | Device flags |
| `onboardedByAdminId` | string | Admin-created user |

**`Session`** — refresh token per device. `revokedAt` set = logged out.  
**`OtpChallenge`** — hashed OTP to `target` (email/phone) for `purpose`. May exist before `userId` is known (signup).  
**`KycProfile`** — 1:1 with user. BVN/NIN, selfie, Prembly provider status, reviewer.  
**`PushDevice`** — Expo/FCM token (`token` unique).  
**`ConsentAcceptance`** — `(userId, docKey)` versions of T&Cs.  
**`AdminUser`** — console login, `role`, encrypted TOTP (`totpSecretEnc` / `totpPendingEnc`).  
**`AdminSession`** — admin refresh token; `locked` for step-up.

**Enums**

| Enum | Values |
|---|---|
| `KycTier` | `TIER_0`, `TIER_1`, `TIER_2` |
| `KycCaseStatus` | `NOT_STARTED`, `IN_PROGRESS`, `PENDING_REVIEW`, `APPROVED`, `REJECTED` |
| `OtpPurpose` | `SIGNUP`, `LOGIN`, `PASSWORD_RESET`, `PIN_RESET`, `ADMIN_LOGIN` |
| `AccountType` | `PERSONAL`, `BUSINESS` |
| `AdminRole` | `SUPER`, `GLOBAL`, `COMPLIANCE`, `OPERATIONS`, `MARKETING`, `FINANCE`, `SUPPORT`, `READ_ONLY` |

---

### 2. Ledger (source of truth for balances)

Balances live on `LedgerAccount.balanceKobo`. Every movement is a `JournalEntry` with ≥2 `JournalLine`s (positive = credit, negative = debit). `Placement` also stores `principalKobo` / `accruedKobo` as product state; the cash still posts through the ledger.

```mermaid
erDiagram
  User ||--o{ LedgerAccount : owns
  LedgerAccount ||--o{ JournalLine : posts
  JournalEntry ||--o{ JournalLine : contains
```

**`LedgerAccount`**

| Column | Meaning |
|---|---|
| `userId` | Null for system accounts |
| `type` | Wallet / call / placement / system |
| `tag` | Distinguishes many `USER_PLACEMENT` rows; `"default"` for wallet/call |
| `currency` | Default `NGN` |
| `balanceKobo` | Cached balance |

Unique: `(userId, type, currency, tag)`.

**`JournalEntry`** — header: `kind`, unique `reference`, optional `idempotencyKey`, `metadata` JSON.  
**`JournalLine`** — `entryId` + `accountId` + `amountKobo`. Deleting an entry cascades lines; deleting an account does not.

**Account types**

| Type | Who | Meaning |
|---|---|---|
| `USER_WALLET` | customer | Spendable wallet |
| `USER_CALL` | customer | Call account |
| `USER_PLACEMENT` | customer | One per fixed/explore plan (`tag`) |
| `SYSTEM_CLEARING` | system | In/out rails |
| `SYSTEM_INTEREST` | system | Interest expense |
| `SYSTEM_FEES` | system | Fees |
| `SYSTEM_SUSPENSE` | system | Holds / exceptions |

**`JournalKind`:** `DEPOSIT`, `WITHDRAWAL`, `CALL_DEPOSIT`, `CALL_WITHDRAW`, `PLACEMENT`, `INTEREST`, `MATURITY`, `ADJUSTMENT`, `FEE`, `REFERRAL`

---

### 3. Money in / money out

```mermaid
erDiagram
  User ||--o{ PaymentIntent : funds
  User ||--o{ CardToken : saves
  User ||--o{ PayoutBank : saves
  User ||--o{ WithdrawalRequest : requests
  PayoutBank ||--o{ WithdrawalRequest : pays_to
```

**`PaymentIntent`** — inbound (Paystack/Monnify). `channel` e.g. card vs transfer. Status `PENDING` → `SUCCESS` / `FAILED`. Success posts a `DEPOSIT` journal.  
**`CardToken`** — saved card (`provider` default `paystack`).  
**`PayoutBank`** — NUBAN. `removedAt` = soft delete so old withdrawals keep `payoutBankId`.  
**`WithdrawalRequest`** — `PROCESSING` → `SUCCESSFUL` / `DECLINED`. `processedByAdminId` is a loose admin id.

| Enum | Values |
|---|---|
| `PaymentStatus` | `PENDING`, `SUCCESS`, `FAILED` |
| `WithdrawalStatus` | `PROCESSING`, `SUCCESSFUL`, `DECLINED` |

---

### 4. Rates, products, placements, gifts

```mermaid
erDiagram
  ProductCategory ||--o{ Product : contains
  Product ||--o{ Placement : subscribed
  Product ||--o{ ProductAccessRequest : gated
  User ||--o{ Placement : holds
  User ||--o{ AutoInvestRule : schedules
  User ||--o{ Gift : sends
  User ||--o{ Gift : receives
  Placement ||--o{ Gift : optional
  RateBand ||--o{ RateChangeRequest : proposes
```

**`RateBand`** — tenor window (`minDays`/`maxDays`) and live `rateBps`.  
**`RateChangeRequest`** — maker-checker. `appliedAt` is when `RateBand` actually updates. `makerAdminId` / `checkerAdminId` are loose admin ids.  
**`ProductCategory` / `Product`** — Explore catalogue. `details` JSON (about, risks, FAQs).  
**`ProductAccessRequest`** — waitlist / large-ticket ask (`userId` stored, no Prisma User relation).  
**`Placement`** — live holding: `kind` CALL / FIXED / EXPLORE. `productId` set for Explore. `ledgerAccountId` is the matching `USER_PLACEMENT` account (logical FK). `maturityInstruction`: `WALLET` | `ROLLOVER` | `PAYOUT`.  
**`AutoInvestRule`** — recurring top-up; `nextRunAt` for the worker.  
**`Gift`** — sender always; recipient user/phone/email until claimed. `claimCode` unique. Placement created on claim.

| Enum | Values |
|---|---|
| `PlacementKind` | `CALL`, `FIXED`, `EXPLORE` |
| `PlacementStatus` | `ACTIVE`, `MATURED`, `CLOSED` |
| `MaturityInstruction` | `WALLET`, `ROLLOVER`, `PAYOUT` |
| `ProductAvailability` | `OPEN`, `CLOSING`, `CLOSED`, `COMING_SOON` |
| `GiftStatus` | `PENDING`, `CLAIMED`, `CANCELLED`, `EXPIRED` |
| `RateChangeStatus` | `PENDING`, `APPROVED`, `REJECTED` |

Rates are **basis points** (`100 bps` = 1%).

---

### 5. Notifications, support, chat, content

```mermaid
erDiagram
  User ||--o{ Notification : receives
  User ||--o| NotificationPref : configures
  User ||--o{ SupportTicket : opens
  SupportTicket ||--o{ SupportTicketMessage : thread
  AdminUser ||--o{ SupportTicket : assigned
  User ||--o{ ChatSession : talks
  ChatSession ||--o{ ChatMessage : contains
  FeedCard ||--o{ FeedCardView : shown_to
  User ||--o{ FeedCardView : sees
```

**`Notification`** — in-app inbox (`readAt` null = unread).  
**`NotificationPref`** — 1:1 email/push toggles.  
**`SupportTicket`** + **`SupportTicketMessage`** — thread; `author` is `USER` | `SUPPORT` | `SYSTEM`. Assignee → `AdminUser` (SetNull).  
**`ChatSession` / `ChatMessage`** — Ask AI; `blocks` JSON for rich replies.  
**`FeedCard` / `FeedCardView`** — home cards; unique `(cardId, userId)` so each account is sent once.  
**`LearnArticle`** — published Learn content; no FKs.

**`TicketStatus`:** `OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`

---

### 6. Ops / config / audit

**`AppConfig`** — key/value JSON for limits, fees, cutoffs, maintenance, feature flags. PK is `key`.  
**`JobRun`** — worker history (`jobName`, `status`, `detail`).  
**`SignupFunnelEvent`** — incomplete signup steps.  
**`AuditEvent`** — `actorUserId` (FK) or `actorAdminId` (loose); `before`/`after` JSON.

---

## Table index

**Identity:** `User`, `Session`, `OtpChallenge`, `PushDevice`, `ConsentAcceptance`  
**KYC:** `KycProfile`  
**Admin:** `AdminUser`, `AdminSession`  
**Ledger:** `LedgerAccount`, `JournalEntry`, `JournalLine`  
**Rails:** `PaymentIntent`, `WithdrawalRequest`, `PayoutBank`, `CardToken`  
**Invest:** `RateBand`, `RateChangeRequest`, `ProductCategory`, `Product`, `ProductAccessRequest`, `Placement`, `AutoInvestRule`, `Gift`  
**Comms:** `Notification`, `NotificationPref`, `SupportTicket`, `SupportTicketMessage`, `ChatSession`, `ChatMessage`  
**Content:** `LearnArticle`, `FeedCard`, `FeedCardView`  
**Ops:** `AppConfig`, `JobRun`, `SignupFunnelEvent`, `AuditEvent`

---

## Table catalog (every table)

Each table below: **what it stores**, **columns**, **keys**, **relations**.

### `User`

Customer account. Hub for almost every other customer table.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | cuid |
| `email` | String? unique | Login |
| `phone` | String? unique | Login / OTP |
| `passwordHash` | String? | Null until password set |
| `firstName` | String | |
| `middleName` | String? | |
| `surname` | String | |
| `accountType` | AccountType | `PERSONAL` (default) or `BUSINESS` |
| `businessName` | String? | Business accounts |
| `businessRcNumber` | String? | CAC / RC |
| `onboardedByAdminId` | String? | Loose admin id |
| `dateOfBirth` | DateTime? | |
| `gender` | String? | |
| `occupation` | String? | |
| `employmentStatus` | String? | |
| `sourceOfFunds` | String? | |
| `addressStreet` | String? | |
| `addressCity` | String? | |
| `addressState` | String? | |
| `addressLga` | String? | |
| `addressPending` | Boolean | Address change awaiting proof |
| `referralCode` | String unique | Their invite code |
| `referredBy` | String? | Other user’s `referralCode` (not FK) |
| `kycTier` | KycTier | Cached `TIER_0` / `_1` / `_2` |
| `pinHash` | String? | Transaction PIN |
| `biometricsLogin` | Boolean | |
| `biometricsTxn` | Boolean | |
| `failedLoginCount` | Int | |
| `lockedUntil` | DateTime? | Login lockout |
| `frozen` | Boolean | Admin freeze |
| `frozenReason` | String? | |
| `monnifyAccountNo` | String? | Virtual NUBAN |
| `monnifyBankName` | String? | |
| `createdAt` / `updatedAt` | DateTime | |

**Relations (1 → many unless noted):** `Session`, `OtpChallenge`, `LedgerAccount`, `AuditEvent`, `ConsentAcceptance`, `KycProfile` (0..1), `Placement`, `PayoutBank`, `CardToken`, `WithdrawalRequest`, `PaymentIntent`, `Gift` sent/received, `Notification`, `SupportTicket`, `ChatSession`, `AutoInvestRule`, `NotificationPref` (0..1), `PushDevice`, `FeedCardView`.

---

### `Session`

Refresh-token login on a device.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `refreshTokenHash` | String indexed | |
| `deviceName` | String? | |
| `userAgent` | String? | |
| `ipAddress` | String? | |
| `lastActiveAt` | DateTime | |
| `revokedAt` | DateTime? | Set = logged out |
| `createdAt` | DateTime | |

---

### `OtpChallenge`

One-time codes for signup, login, password/PIN reset, admin login.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String? FK → User | Null during signup before user exists |
| `target` | String | Email or phone |
| `purpose` | OtpPurpose | |
| `codeHash` | String | Never store raw OTP |
| `attempts` | Int | |
| `expiresAt` | DateTime | |
| `consumedAt` | DateTime? | Used |
| `createdAt` | DateTime | |

Index: `(target, purpose)`.

---

### `KycProfile`

One KYC case per user (1:1). BVN/NIN, liveness, Prembly status, reviewer.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String unique FK → User | Cascade |
| `status` | KycCaseStatus | |
| `bvn` / `bvnName` / `bvnMatchScore` | | |
| `nin` / `ninName` / `ninMatchScore` | | |
| `livenessPassed` | Boolean | |
| `selfieUrl` | String? | |
| `addressDocUrl` | String? | Proof of address |
| `rejectionReason` | String? | |
| `provider` | String? | e.g. Prembly |
| `bvnProviderStatus` | String? | PENDING / SUCCESS / FAILED / RETRY |
| `ninProviderStatus` | String? | same |
| `providerAttempts` | Int | |
| `providerLastError` | String? | |
| `providerReference` | String? | |
| `providerCheckedAt` | DateTime? | |
| `reviewedByAdminId` | String? | Loose admin id |
| `reviewedAt` | DateTime? | |
| `createdAt` / `updatedAt` | DateTime | |

---

### `PushDevice`

Expo / FCM token for the mobile app.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `token` | String unique | |
| `platform` | String? | ios / android |
| `deviceName` | String? | |
| `createdAt` / `updatedAt` | DateTime | |

---

### `ConsentAcceptance`

Which legal docs a user accepted.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `docKey` | String | e.g. terms |
| `version` | String | |
| `acceptedAt` | DateTime | |

Index: `(userId, docKey)`.

---

### `AdminUser`

Console operator (separate from `User`).

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `email` | String unique | |
| `name` | String | |
| `passwordHash` | String | |
| `role` | AdminRole | |
| `pinHash` | String? | |
| `department` | String? | |
| `phone` | String? | |
| `invitePending` | Boolean | Invited, not yet set password |
| `require2fa` | Boolean | Policy flag |
| `totpSecretEnc` | String? | AES-GCM confirmed secret |
| `totpPendingEnc` | String? | Enroll until confirmed |
| `totpEnabled` | Boolean | |
| `totpConfirmedAt` | DateTime? | |
| `makerChecker` | Boolean | Dual control |
| `active` | Boolean | |
| `createdAt` / `updatedAt` | DateTime | |

**Relations:** `AdminSession` (1→many), assigned `SupportTicket` (1→many).

---

### `AdminSession`

Admin refresh token. `locked` = needs step-up (PIN/TOTP). `revokedAt` = logged out.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `adminId` | String FK → AdminUser | Cascade |
| `refreshTokenHash` | String | |
| `locked` | Boolean | |
| `lastActiveAt` | DateTime | |
| `revokedAt` | DateTime? | |
| `createdAt` | DateTime | |

---

### `LedgerAccount`

Balance bucket. System rows have `userId` null.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String? FK → User | Cascade if set |
| `type` | LedgerAccountType | Wallet, call, placement, system |
| `tag` | String | `"default"`; unique per placement |
| `currency` | String | Default `NGN` |
| `balanceKobo` | BigInt | Cached balance |
| `createdAt` / `updatedAt` | DateTime | |

Unique: `(userId, type, currency, tag)`. **Has many** `JournalLine`.

---

### `JournalEntry`

Double-entry header (one economic event).

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `kind` | JournalKind | DEPOSIT, PLACEMENT, … |
| `reference` | String unique | Human/ops ref |
| `idempotencyKey` | String? unique | Prevents double post |
| `description` | String? | |
| `metadata` | Json? | |
| `createdAt` | DateTime | |

**Has many** `JournalLine` (cascade).

---

### `JournalLine`

One side of a journal (credit or debit).

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `entryId` | String FK → JournalEntry | Cascade |
| `accountId` | String FK → LedgerAccount | **No cascade** |
| `amountKobo` | BigInt | Positive credit, negative debit |
| `createdAt` | DateTime | |

---

### `PaymentIntent`

Inbound funding attempt (card / transfer).

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `provider` | String | paystack, monnify, … |
| `channel` | String | card, transfer, … |
| `amountKobo` | BigInt | |
| `feeKobo` | BigInt | |
| `status` | PaymentStatus | PENDING / SUCCESS / FAILED |
| `reference` | String unique | Our ref |
| `providerRef` | String? indexed | Provider’s id |
| `authorizationUrl` | String? | Checkout URL |
| `metadata` | Json? | |
| `createdAt` | DateTime | |
| `completedAt` | DateTime? | |

Success posts a `DEPOSIT` journal to `USER_WALLET`.

---

### `CardToken`

Saved card for later charges / auto-invest.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `provider` | String | Default `paystack` |
| `token` | String | Provider token |
| `last4` | String | Display |
| `brand` | String? | visa, mastercard |
| `nickname` | String? | |
| `createdAt` | DateTime | |

---

### `PayoutBank`

Saved NUBAN. Soft-deleted via `removedAt`.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `bankCode` | String | |
| `bankName` | String | |
| `accountNumber` | String | |
| `accountName` | String | |
| `nameMatched` | Boolean | Name enquiry OK |
| `removedAt` | DateTime? | Hidden from lists |
| `createdAt` | DateTime | |

**Has many** `WithdrawalRequest`.

---

### `WithdrawalRequest`

Wallet → bank payout.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `payoutBankId` | String FK → PayoutBank | Restrict |
| `amountKobo` | BigInt | |
| `status` | WithdrawalStatus | PROCESSING / SUCCESSFUL / DECLINED |
| `declineReason` | String? | |
| `reference` | String unique | |
| `providerRef` | String? | |
| `processedByAdminId` | String? | Loose admin id |
| `processedAt` | DateTime? | |
| `createdAt` / `updatedAt` | DateTime | |

---

### `RateBand`

Live tenor rate (fixed products).

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `code` | String unique | e.g. `CALL`, `91-120` |
| `label` | String | |
| `minDays` | Int | |
| `maxDays` | Int? | Null = open-ended |
| `rateBps` | Int | 100 bps = 1% |
| `effectiveFrom` | DateTime | |
| `createdAt` / `updatedAt` | DateTime | |

**Has many** `RateChangeRequest`.

---

### `RateChangeRequest`

Maker-checker rate change.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `bandId` | String FK → RateBand | Restrict |
| `proposedBps` | Int | |
| `previousBps` | Int? | Snapshot at propose |
| `effectiveFrom` | DateTime | When it should go live |
| `status` | RateChangeStatus | PENDING / APPROVED / REJECTED |
| `reason` | String? | |
| `makerAdminId` | String | Loose |
| `checkerAdminId` | String? | Loose |
| `decidedAt` | DateTime? | |
| `appliedAt` | DateTime? | Written onto RateBand |
| `createdAt` | DateTime | |

---

### `ProductCategory`

Explore catalogue grouping.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `slug` | String unique | URL |
| `name` | String | |
| `sortOrder` | Int | |

**Has many** `Product`.

---

### `Product`

Explore product (not the same as a RateBand fixed tenor).

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `categoryId` | String FK → ProductCategory | Restrict |
| `slug` | String unique | |
| `name` | String | |
| `blurb` | String | Short |
| `description` | String? | |
| `details` | Json? | about, how, risks, faqs, … |
| `rateBps` | Int | |
| `tenorDays` | Int | |
| `minimumKobo` | BigInt | |
| `availability` | ProductAvailability | OPEN / CLOSING / CLOSED / COMING_SOON |
| `issuer` | String? | |
| `largeTicket` | Boolean | Gated |
| `termsVersion` | String | |
| `createdAt` / `updatedAt` | DateTime | |

**Has many** `Placement`, `ProductAccessRequest`.

---

### `ProductAccessRequest`

User asked for a gated / large-ticket product. `userId` is stored, not a Prisma User FK.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `productId` | String FK → Product | |
| `userId` | String | Logical user |
| `message` | String? | |
| `createdAt` | DateTime | |

---

### `Placement`

Live holding: call, fixed, or explore.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `kind` | PlacementKind | CALL / FIXED / EXPLORE |
| `productId` | String? FK → Product | Explore only |
| `name` | String | Display / nickname |
| `principalKobo` | BigInt | |
| `rateBps` | Int | Locked at booking |
| `tenorDays` | Int? | |
| `startDate` | DateTime | |
| `maturityDate` | DateTime? | |
| `status` | PlacementStatus | ACTIVE / MATURED / CLOSED |
| `maturityInstruction` | MaturityInstruction | WALLET / ROLLOVER / PAYOUT |
| `accruedKobo` | BigInt | Interest accrued |
| `ledgerAccountId` | String? | Logical → LedgerAccount (not Prisma FK) |
| `goalKobo` | BigInt? | Savings goal |
| `isGift` | Boolean | From a gift claim |
| `createdAt` / `updatedAt` | DateTime | |

**Has many** `Gift` (when a gift funds this placement). Indexes: `(userId, status)`, `(maturityDate, status)`.

---

### `Gift`

Investment gift. Placement is created on **claim**, not send.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `senderId` | String FK → User | GiftsSent |
| `recipientId` | String? FK → User | After claim / known user |
| `recipientPhone` | String? | Invite by phone |
| `recipientEmail` | String? | Invite by email |
| `recipientName` | String? | |
| `placementId` | String? FK → Placement | After claim |
| `claimCode` | String unique | |
| `message` | String? | |
| `tenorDays` | Int | Default 90 |
| `status` | GiftStatus | PENDING / CLAIMED / CANCELLED / EXPIRED |
| `amountKobo` | BigInt | |
| `createdAt` | DateTime | |
| `claimedAt` | DateTime? | |
| `expiresAt` | DateTime? | |

---

### `AutoInvestRule`

Recurring top-up from wallet/card.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `label` | String | |
| `amountKobo` | BigInt | |
| `dayOfMonth` | Int | |
| `frequency` | String | Monthly, Weekly, … |
| `active` | Boolean | |
| `cardTokenId` | String? | Logical card |
| `lastRunAt` | DateTime? | |
| `nextRunAt` | DateTime? | Worker pickup |
| `createdAt` | DateTime | |

Index: `(active, nextRunAt)`.

---

### `Notification`

In-app inbox row.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `title` | String | |
| `body` | String | |
| `href` | String? | Deep link |
| `readAt` | DateTime? | Null = unread |
| `createdAt` | DateTime | |

---

### `NotificationPref`

One row of email/push toggles per user.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String unique FK → User | Cascade |
| `emailDeposits` … `emailMarketing` | Boolean | Email channels |
| `pushDeposits` … `pushKyc` | Boolean | Push channels |

---

### `LearnArticle`

Published Learn CMS. No FKs.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `slug` | String unique | |
| `title` | String | |
| `summary` | String | |
| `body` | String | |
| `category` | String? | |
| `published` | Boolean | |
| `createdAt` | DateTime | |

---

### `FeedCard`

Home feed card published by admin.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `title` | String | |
| `body` | String | |
| `kind` | String | Card type |
| `href` | String? | |
| `active` | Boolean | |
| `sortOrder` | Int | |
| `createdAt` | DateTime | |

**Has many** `FeedCardView`.

---

### `FeedCardView`

“This user was shown this card.” Unique `(cardId, userId)`.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `cardId` | String FK → FeedCard | Cascade |
| `userId` | String FK → User | Cascade |
| `createdAt` | DateTime | |

---

### `SupportTicket`

Customer ticket.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `category` | String | |
| `subject` | String | |
| `body` | String | First message |
| `attachmentUrl` | String? | /uploads/support/… |
| `attachmentName` | String? | |
| `assigneeAdminId` | String? FK → AdminUser | SetNull |
| `priority` | String | urgent / high / normal / low |
| `status` | TicketStatus | OPEN … CLOSED |
| `createdAt` / `updatedAt` | DateTime | |

**Has many** `SupportTicketMessage`.

---

### `SupportTicketMessage`

Thread on a ticket. `author` = `USER` | `SUPPORT` | `SYSTEM`.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `ticketId` | String FK → SupportTicket | Cascade |
| `author` | String | |
| `body` | String | |
| `attachmentUrl` | String? | |
| `attachmentName` | String? | |
| `createdAt` | DateTime | |

---

### `ChatSession`

Ask AI conversation.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `userId` | String FK → User | Cascade |
| `flagged` | Boolean | Review flag |
| `createdAt` | DateTime | |

**Has many** `ChatMessage`.

---

### `ChatMessage`

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `sessionId` | String FK → ChatSession | Cascade |
| `role` | String | user / assistant |
| `content` | String | Text |
| `blocks` | Json? | Rich UI blocks |
| `createdAt` | DateTime | |

---

### `AuditEvent`

Who changed what. Customer actor is an FK; admin actor is a loose id.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `actorUserId` | String? FK → User | Restrict |
| `actorAdminId` | String? | Loose |
| `action` | String indexed | |
| `entityType` | String? | |
| `entityId` | String? | |
| `before` / `after` | Json? | Diff |
| `ipAddress` | String? | |
| `userAgent` | String? | |
| `createdAt` | DateTime indexed | |

---

### `JobRun`

Worker job history (recon, interest, cutoffs, …).

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `jobName` | String | |
| `status` | String | |
| `detail` | Json? | |
| `startedAt` | DateTime | |
| `finishedAt` | DateTime? | |

---

### `SignupFunnelEvent`

Incomplete signup analytics. No user FK.

| Column | Type | Notes |
|---|---|---|
| `id` | String PK | |
| `email` | String? | |
| `phone` | String? | |
| `deviceId` | String? | |
| `step` | String | Funnel step |
| `completed` | Boolean | |
| `metadata` | Json? | |
| `createdAt` | DateTime | |

---

### `AppConfig`

System settings. PK is the config **key**, value is JSON.

| Column | Type | Notes |
|---|---|---|
| `key` | String PK | e.g. limits, maintenance |
| `value` | Json | |
| `updatedAt` | DateTime | |
| `updatedBy` | String? | Loose admin id |

---

## Typical money path

```mermaid
sequenceDiagram
  participant User
  participant PaymentIntent
  participant Journal
  participant Wallet as LedgerAccount USER_WALLET
  participant Placement

  User->>PaymentIntent: card / transfer
  PaymentIntent-->>Journal: DEPOSIT on success
  Journal->>Wallet: credit kobo
  User->>Placement: create fixed / explore
  Placement-->>Journal: PLACEMENT
  Journal->>Wallet: debit
  Journal->>Placement: credit USER_PLACEMENT account
```

---

Schema source of truth: [`prisma/schema.prisma`](../prisma/schema.prisma). Migrations: `prisma/migrations/`.
