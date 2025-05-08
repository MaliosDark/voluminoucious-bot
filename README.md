
<p align="center">
  <img src="welcome.png" alt="Voluminoucious Bot Banner" width="700"/>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Node.js-23.11.0-339933?logo=nodedotjs&logoColor=white&style=flat-square"/>
  <img src="https://img.shields.io/badge/npm-v10.2.3-CB3837?logo=npm&logoColor=white&style=flat-square"/>
  <img src="https://img.shields.io/badge/JavaScript-ES2022-F7DF1E?logo=javascript&logoColor=black&style=flat-square"/>
  <img src="https://img.shields.io/badge/Telegram-Bot-2CA5E0?logo=telegram&logoColor=white&style=flat-square"/>
  <img src="https://img.shields.io/badge/Solana-Blockchain-3a0ca3?logo=solana&logoColor=white&style=flat-square"/>
  <img src="https://img.shields.io/badge/solana--web3.js-Solana-purple?style=flat-square"/>
  <img src="https://img.shields.io/badge/solana--swap-Custom-orange?style=flat-square"/>
  <img src="https://img.shields.io/badge/node--fetch-v3.4.0-lightblue?style=flat-square"/>
  <img src="https://img.shields.io/badge/Encrypted-AES--256--GCM-orange?style=flat-square"/>
  <img src="https://img.shields.io/badge/Data%20Feed-CoinGecko-yellowgreen?style=flat-square"/>
  <img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat-square"/>
  <img src="https://img.shields.io/badge/Status-Beta-yellow?style=flat-square"/>
</p>

---

# 📈 Voluminoucious Bot for Solana on Telegram

---

## 🎯 1. Introduction

**Voluminoucious Bot** is a Telegram-based trading assistant designed for the Solana blockchain. It offers:

* **Automated volume trading** cycles on any SPL token.
* **Management of multiple wallets** per user: one **main** and configurable **secondary** wallets.
* **Deposit splitting**, execution of randomized buy/sell cycles, and stopping at a safe threshold.
* **Platform fee reservation**: 38% of the deposit is reserved for platform fees.
* **Secure state persistence** using AES-GCM–encrypted storage, ensuring session continuity.
* **Live token metrics** fetched from CoinGecko, including price, market cap, volume, supply, rank, and percentage changes.
* **Interactive Telegram panel** with actions to:

  * Start/Reset session
  * Add wallet
  * Set token mint
  * Configure parameters
  * Run/Stop volume trading
  * Sell all tokens back to SOL
  * Withdraw all SOL

---

## ⚙️ 2. Architecture & Data Flow

```mermaid
flowchart LR
  A[/start command/] --> B[Load or Init Session]
  B --> C{Session exists?}
  C -->|Yes| D[Build panel from file]
  C -->|No| E[Create new panel]
  D --> F[Show Telegram panel]
  E --> F
  F --> G[Button: Set Mint]
  F --> H[Button: Add Wallet]
  F --> I[Button: Configure]
  F --> J[Button: Run Volume]
  I --> K[Text: /setMaxWallets <n>]
  K --> L[Text: /setBuyCycles <n>]
  L --> M[Text: /setDelayMs <ms>]
  J --> N[Loop through secondaries]
  N --> O[Buy/Sell random split]
  O --> N
  N --> P[Stop at 40% SOL]
  P --> Q[Transfer profit to main]
  Q --> F
  F --> R[Button: Stop Volume]
  F --> S[Button: Sell All]
  F --> T[Button: Withdraw Funds]
  F --> U[Button: New Session → Reset + Reserve]
  U --> E
```

---

## 📦 3. Prerequisites

* **Node.js v16+**
* **npm**
* A **Telegram bot token** (obtainable via [BotFather](https://t.me/BotFather))
* A **Solana Devnet RPC URL**
* A **32-byte base64 AES key** for encrypted storage
* A **fee collection wallet** (public key) for platform fees

---

## 🔧 4. Installation & Start

```bash
git clone https://github.com/MaliosDark/voluminoucious-bot.git
cd voluminoucious-bot
npm install
npm start 
```

---

## 📝 5. Configuration

Create a `.env` file in the project root:

```ini
TELEGRAM_TOKEN=<your-telegram-bot-token>
RPC_URL=https://api.devnet.solana.com
DB_KEY=<32-byte-base64-string>
FEE_WALLET=<YourFeeWalletPublicKey>
```

* **`DB_KEY`**: Generate a secure 32-byte key, e.g., using `openssl rand -base64 32`.
* **`FEE_WALLET`**: Public key where platform fees are collected.

---

## 🔍 6. Session Structure

Each user session is identified by their **Telegram username** or **user ID**. The session structure includes:

```js
{
  main: Keypair,                    // Main wallet for deposits and consolidation
  secondaries: Keypair[],           // Array of secondary wallets
  tokenMint: string | null,         // SPL token address
  panelMsg: { chat_id, message_id },// Telegram panel reference
  stats: { initial, final, actions, start } | null,
  config: { maxWallets, buyCycles, delayMs },
  geckoCache: { ts, info } | null   // Cached CoinGecko data
}
```

* Sessions are **encrypted** using AES-GCM and stored in `.data-voluminousy/sessions.enc`.

---

## 🗺️ 7. Commands & Buttons

### 7.1 Telegram Buttons

| Button         | Description                                             |
| -------------- | ------------------------------------------------------- |
| 🆕 New Session | Reset session—collect all funds to fee wallet + reserve |
| ➕ Add Wallet   | Create another secondary wallet                         |
| 💳 Set Mint    | Prompt for SPL mint to trade                            |
| ⚙️ Configure   | Shows text commands for advanced configuration          |
| 🚀 Run Volume  | Begin buy/sell automation                               |
| 🛑 Stop        | Immediately halt volume job                             |
| 💸 Sell All    | Liquidate all SPL tokens → SOL, transfer to main        |
| 🏦 Withdraw    | Transfer all SOL from main → user’s address             |
| 🔍 Show Main   | Display main wallet balances                            |
| ℹ️ Show Stats  | Show elapsed time, actions, profit                      |

### 7.2 Text Commands

```text
/setMaxWallets <n>   — Limit of secondary wallets (1–50)
/setBuyCycles <n>    — Number of randomized buy/sell cycles
/setDelayMs <ms>     — Delay between swap transactions (ms)
```

---

## ⚙️ 8. Typical Workflow

1. **/start**: Bot loads or initializes session and sends control panel.
2. **Deposit**: Send ≥0.5 SOL to the **main** wallet address displayed via "Show Main".
3. **Set Mint**: Use the button to specify the SPL token to trade.
4. **Add Wallet**: Create up to `maxWallets` secondary wallets.
5. **Run Volume**:

   * Bot reserves 38% of the main wallet's balance to the fee wallet.
   * Remaining SOL is split randomly among secondary wallets.
   * Each secondary performs randomized buy/sell cycles.
   * Trading halts when a wallet's SOL balance drops below 40%.
   * Profits are consolidated back into the main wallet.
6. **Stop**: Halt the trading process at any time.
7. **Sell All**: Convert all SPL tokens back to SOL and transfer to the main wallet.
8. **Withdraw**: Send all SOL from the main wallet to the user's Solana address.

---

## 🛠️ 9. Error Handling & Resilience

* **Robust Error Handling**: All asynchronous operations are wrapped in try/catch blocks to log errors and notify users.
* **Session Persistence**: Sessions are automatically saved after each state change.
* **Periodic Panel Refresh**: The Telegram panel is updated every 60 seconds to reflect the latest status.
* **Safe Session Reset**: The "New Session" action ensures all funds are collected to the fee wallet, preventing stranded assets.

---

## 🔄 10. Fee Structure

* **Platform Reserve**: 38% of the main wallet's balance is transferred to the fee wallet at the start of a volume run.
* **Optional Transaction Fee**: An additional 1% fee per transaction can be enabled by uncommenting the relevant lines in the code.

---

## 📊 11. Token Metrics Integration

The bot fetches real-time token data from CoinGecko, including:

* **Price**: Current USD price.
* **Market Cap**: Total market capitalization.
* **Volume (24h)**: Trading volume over the past 24 hours.
* **Circulating Supply**: Number of tokens in circulation.
* **Total Supply**: Total number of tokens.
* **Price Changes**: Percentage changes over 1h, 24h, and 7d.
* **Rank**: Market cap rank.

This information is displayed in the Telegram panel for user reference.

---

## 🔐 12. Security Considerations

* **Encrypted Storage**: All session data is encrypted using AES-GCM.
* **Key Management**: Private keys are securely managed within the application.
* **User Authentication**: Actions are tied to the user's Telegram ID to prevent unauthorized access.


