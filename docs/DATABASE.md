# Kipit database

**Engine:** PostgreSQL  
**ORM:** Prisma (`kipit-api/prisma/schema.prisma`)  
**Connection:** `DATABASE_URL`

Money is stored as **kobo** (`BigInt`). IDs are **cuid** strings unless noted.

---

## High-level map

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

## 1. Users, auth, KYC

A customer is one `User`. Login uses hashed password + OTP + refresh `Session`. KYC lives on `KycProfile` (1:1). Admins are a separate table (`AdminUser`), not the same as customers.

```mermaid
erDiagram
  User ||--o{ Session : has
  User ||--o{ OtpChallenge : has
  User ||--o| KycProfile : has
  User ||--o{ ConsentAcceptance : accepts
  User ||--o{ PushDevice : registers
  AdminUser ||--o{ AdminSession : has

  User {
    string id PK
    string email UK
    string phone UK
    string passwordHash
    string pinHash
    enum kycTier
    bool frozen
    string referralCode UK
    string referredBy
    string monnifyAccountNo
  }

  Session {
    string id PK
    string userId FK
    string refreshTokenHash
    datetime revokedAt
  }

  OtpChallenge {
    string id PK
    string userId FK
    string target
    enum purpose
    string codeHash
    datetime expiresAt
  }

  KycProfile {
    string id PK
    string userId UK
    enum status
    string bvn
    string nin
    bool livenessPassed
    string selfieUrl
  }

  AdminUser {
    string id PK
    string email UK
    enum role
    bool totpEnabled
    string totpSecretEnc
  }
```

**Enums (identity)**

| Enum | Values |
|---|---|
| `KycTier` | `TIER_0`, `TIER_1`, `TIER_2` |
| `KycCaseStatus` | `NOT_STARTED`, `IN_PROGRESS`, `PENDING_REVIEW`, `APPROVED`, `REJECTED` |
| `OtpPurpose` | `SIGNUP`, `LOGIN`, `PASSWORD_RESET`, `PIN_RESET`, `ADMIN_LOGIN` |
| `AccountType` | `PERSONAL`, `BUSINESS` |
| `AdminRole` | `SUPER`, `GLOBAL`, `COMPLIANCE`, `OPERATIONS`, `MARKETING`, `FINANCE`, `SUPPORT`, `READ_ONLY` |

---

## 2. Ledger (source of truth for balances)

Balances are **not** stored only on placements. Each wallet / call / placement has a `LedgerAccount`. Moves go through double-entry: one `JournalEntry` with two or more `JournalLine`s (positive = credit, negative = debit).

```mermaid
erDiagram
  User ||--o{ LedgerAccount : owns
  LedgerAccount ||--o{ JournalLine : posts
  JournalEntry ||--o{ JournalLine : contains

  LedgerAccount {
    string id PK
    string userId FK
    enum type
    string tag
    string currency
    bigint balanceKobo
  }

  JournalEntry {
    string id PK
    enum kind
    string reference UK
    string idempotencyKey UK
    json metadata
  }

  JournalLine {
    string id PK
    string entryId FK
    string accountId FK
    bigint amountKobo
  }
```

**Account types (`LedgerAccountType`)**

| Type | Who | Meaning |
|---|---|---|
| `USER_WALLET` | customer | Spendable wallet |
| `USER_CALL` | customer | Call account balance |
| `USER_PLACEMENT` | customer | One account per fixed/explore placement (`tag` distinguishes them) |
| `SYSTEM_CLEARING` | system | In/out rails (Monnify, Paystack, payouts) |
| `SYSTEM_INTEREST` | system | Interest expense |
| `SYSTEM_FEES` | system | Fees |
| `SYSTEM_SUSPENSE` | system | Holds / exceptions |

**Journal kinds:** `DEPOSIT`, `WITHDRAWAL`, `CALL_DEPOSIT`, `CALL_WITHDRAW`, `PLACEMENT`, `INTEREST`, `MATURITY`, `ADJUSTMENT`, `FEE`, `REFERRAL`

Unique per user account: `(userId, type, currency, tag)`.

---

## 3. Money in / money out

```mermaid
erDiagram
  User ||--o{ PaymentIntent : funds
  User ||--o{ CardToken : saves
  User ||--o{ PayoutBank : saves
  User ||--o{ WithdrawalRequest : requests
  PayoutBank ||--o{ WithdrawalRequest : pays_to

  PaymentIntent {
    string id PK
    string userId FK
    string provider
    string channel
    bigint amountKobo
    enum status
    string reference UK
  }

  WithdrawalRequest {
    string id PK
    string userId FK
    string payoutBankId FK
    bigint amountKobo
    enum status
    string reference UK
  }

  PayoutBank {
    string id PK
    string userId FK
    string bankCode
    string accountNumber
    datetime removedAt
  }

  CardToken {
    string id PK
    string userId FK
    string token
    string last4
  }
```

| Enum | Values |
|---|---|
| `PaymentStatus` | `PENDING`, `SUCCESS`, `FAILED` |
| `WithdrawalStatus` | `PROCESSING`, `SUCCESSFUL`, `DECLINED` |

`PayoutBank.removedAt` is a soft delete so old withdrawals keep their bank FK.

---

## 4. Rates, products, placements, gifts

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

  RateBand {
    string id PK
    string code UK
    int minDays
    int maxDays
    int rateBps
  }

  Product {
    string id PK
    string slug UK
    int rateBps
    int tenorDays
    bigint minimumKobo
    enum availability
  }

  Placement {
    string id PK
    string userId FK
    enum kind
    string productId FK
    bigint principalKobo
    int rateBps
    enum status
    enum maturityInstruction
    string ledgerAccountId
  }

  Gift {
    string id PK
    string senderId FK
    string claimCode UK
    enum status
    bigint amountKobo
  }
```

| Enum | Values |
|---|---|
| `PlacementKind` | `CALL`, `FIXED`, `EXPLORE` |
| `PlacementStatus` | `ACTIVE`, `MATURED`, `CLOSED` |
| `MaturityInstruction` | `WALLET`, `ROLLOVER`, `PAYOUT` |
| `ProductAvailability` | `OPEN`, `CLOSING`, `CLOSED`, `COMING_SOON` |
| `GiftStatus` | `PENDING`, `CLAIMED`, `CANCELLED`, `EXPIRED` |
| `RateChangeStatus` | `PENDING`, `APPROVED`, `REJECTED` |

Rates are **basis points** (`rateBps`). Maker-checker rate edits go through `RateChangeRequest` (`appliedAt` is when they actually hit `RateBand`).

---

## 5. Notifications, support, chat, content

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

  Notification {
    string id PK
    string userId FK
    string title
    datetime readAt
  }

  SupportTicket {
    string id PK
    string userId FK
    string category
    enum status
    string priority
  }

  ChatSession {
    string id PK
    string userId FK
    bool flagged
  }
```

`LearnArticle` and `FeedCard` are CMS-style tables (no user FK except `FeedCardView`).

---

## 6. Ops / config / audit

| Table | Role |
|---|---|
| `AppConfig` | Key/value JSON (`key` PK) — limits, fees, cutoffs, maintenance, flags |
| `JobRun` | Worker job history |
| `SignupFunnelEvent` | Incomplete signup analytics |
| `AuditEvent` | Who did what (`actorUserId` or `actorAdminId`) |

```mermaid
erDiagram
  User ||--o{ AuditEvent : actor
  AppConfig {
    string key PK
    json value
    string updatedBy
  }
  JobRun {
    string id PK
    string jobName
    string status
    json detail
  }
  AuditEvent {
    string id PK
    string actorUserId FK
    string actorAdminId
    string action
    json before
    json after
  }
```

---

## Tables (quick index)

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

## Typical money path

```mermaid
sequenceDiagram
  participant User
  participant PaymentIntent
  participant Journal
  participant Wallet as LedgerAccount USER_WALLET
  participant Placement

  User->>PaymentIntent: card / transfer
  PaymentIntent-->>Journal: DEPOSIT (on success)
  Journal->>Wallet: credit kobo
  User->>Placement: create fixed/explore
  Placement-->>Journal: PLACEMENT
  Journal->>Wallet: debit
  Journal->>Placement: credit USER_PLACEMENT account
```

---

Schema source of truth: [`prisma/schema.prisma`](../prisma/schema.prisma). Migrations live in `prisma/migrations/`.
