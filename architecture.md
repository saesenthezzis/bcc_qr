## **1. Folder & File Structure**

```text
creditbridge-rpa/
├── .env                    # Secrets (Bank Login, Telegram Token, Supabase URL)
├── .dockerignore           # Exclude node_modules and storage from Docker build
├── Dockerfile              # Playwright-based container definition
├── docker-compose.yml      # Orchestration (Volumes, Auto-restart)
├── package.json            # Dependencies & Scripts
├── tsconfig.json           # TypeScript configuration
├── src/
│   ├── index.ts            # Entry Point (Main Loop & Scheduler)
│   ├── agents/
│   │   ├── Surveillance.ts # Crawlee/Playwright Scraper
│   │   ├── Registry.ts     # Supabase (Database) Client
│   │   ├── Generator.ts    # 1C-String & QR Rendering
│   │   └── Dispatcher.ts   # Telegram Bot Logic
│   ├── utils/
│   │   ├── Sanitizer.ts    # Currency/String cleaning
│   │   └── Logger.ts       # Winston/Pino for audit logs
│   └── types/
│       └── index.ts        # Shared TypeScript Interfaces (Order, Config)
└── storage/                # LOCAL ONLY: Persistent browser cookies/sessions

```

---

## **2. Component Responsibilities**

### **The Entry Point (`src/index.ts`)**

* **Orchestrator:** Acts as the "Heartbeat." It uses `node-cron` or a `while(true)` loop to trigger the process every 60 seconds.
* **Pipeline Flow:** It fetches data from the `Surveillance` agent, passes it to the `Registry` for checking, and if new, triggers the `Generator` and `Dispatcher`.

### **Surveillance Agent (`src/agents/Surveillance.ts`)**

* **Browser Management:** Uses Crawlee's `PlaywrightCrawler`.
* **Automation:** Logs into the bank, waits for the table to load, and scrapes row data.
* **Stealth:** Manages the `storage/` directory to reuse session cookies, avoiding constant MFA/Logins.

### **Registry Agent (`src/agents/Registry.ts`)**

* **State Verification:** Queries Supabase to see if the `external_id` already exists.
* **Persistence:** Saves the order details once processed to ensure it’s never sent twice.

### **Generator Agent (`src/agents/Generator.ts`)**

* **Template Logic:** Formats the static string: `AI1|KZ282|2489604|${amount}.00|210140004940|KZ10609|1|0.00|1`.
* **Rendering:** Uses the `qrcode` library to turn that string into an image Buffer.

### **Dispatcher Agent (`src/agents/Dispatcher.ts`)**

* **Communication:** Wraps `Telegraf`. It sends the QR Buffer as a photo to the authorized `CHAT_ID`.
* **Command Handling:** Allows managers to check system status via `/status`.

---

## **3. Where State Lives & How Services Connect**

### **Persistent State (The "Long-Term Memory")**

* **Location:** **Supabase (PostgreSQL)**.
* **Connection:** The `Registry Agent` connects via the Supabase Service Role Key. This is the source of truth for which orders have been "Paid" in 1C.

### **Session State (The "Short-Term Memory")**

* **Location:** **`/storage` directory** (Docker Volume).
* **Connection:** The `Surveillance Agent` reads/writes cookies here. This prevents the bank from blocking the account due to too many login attempts.

### **Service Interconnection**

The services connect via a **Linear Dependency Injection** pattern in `index.ts`:

1. **Bank Portal** $\rightarrow$ *[HTTP/DOM]* $\rightarrow$ **Surveillance Agent**
2. **Surveillance Agent** $\rightarrow$ *[JSON Object]* $\rightarrow$ **Registry Agent** (Check DB)
3. **Registry Agent** $\rightarrow$ *[Boolean]* $\rightarrow$ **Generator Agent** (If True)
4. **Generator Agent** $\rightarrow$ *[Image Buffer]* $\rightarrow$ **Dispatcher Agent**
5. **Dispatcher Agent** $\rightarrow$ *[Telegram API]* $\rightarrow$ **Staff Member**

---

## **4. Deployment (The Docker Layer)**

The `docker-compose.yml` ensures the architecture is resilient:

* **Restart Policy:** `unless-stopped` (if the bot crashes, Docker brings it back up).
* **Volumes:** Maps the local `./storage` to `/app/storage` in the container so session data isn't lost when the container updates.
* **Environment:** Passes the `.env` variables securely into the Node.js runtime.
