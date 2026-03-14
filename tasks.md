Phase 1: Project Skeleton & Containerization
Goal: Create a reproducible environment where browsers can run.

Task: Core Initialization

Start: Create project folder.

Action: Initialize npm, install typescript, and set up tsconfig.json. Install dependencies: crawlee, playwright, telegraf, @supabase/supabase-js, qrcode, and dotenv.

End: npx tsc runs without errors on an empty index.ts.

Task: Docker Infrastructure

Start: Create Dockerfile.

Action: Use mcr.microsoft.com/playwright:v1.42.0-jammy as base. Set up docker-compose.yml to mount a storage volume (for cookies).

End: docker-compose up builds and runs a simple "Hello Node" script successfully.

Phase 2: The Registry Agent (Supabase State)
Goal: Ensure we never process the same order twice.

Task: Database Schema

Start: Access Supabase SQL Editor.

Action: Create a table processed_orders with columns: external_id (TEXT, UNIQUE), amount (NUMERIC), and created_at (TIMESTAMPTZ).

End: Table is visible in Supabase dashboard.

Task: Registry Logic - Check

Start: Create RegistryAgent.ts.

Action: Write an async function isOrderNew(id: string) that returns true if the ID is missing from Supabase.

End: Test script logs true for a random ID and false after you manually add that ID to the DB.

Task: Registry Logic - Save

Start: Update RegistryAgent.ts.

Action: Write a function markAsProcessed(id: string, amount: number) to insert the record.

End: Function execution results in a new row in Supabase.

Phase 3: The Surveillance Agent (Crawlee/Scraper)
Goal: Authenticate and extract raw data.

Task: Headless Authentication

Start: Create SurveillanceAgent.ts.

Action: Use PlaywrightCrawler to go to the login URL, fill credentials from .env, and click "Login." Use persistCookies: true.

End: The bot successfully reaches the "Cashier Cabinet" dashboard (verify by logging the page title).

Task: Table Extraction

Start: Update SurveillanceAgent.ts.

Action: Write a locator to find the orders table. Extract the Order ID and the Amount from the first row.

End: Console logs a clean object: { external_id: "2489604", amount: "852937.00" }.

Task: Data Sanitizer

Start: Create utility function in SurveillanceAgent.ts.

Action: Clean the amount string (remove spaces, currency symbols) and ensure it's a valid float.

End: Input "852 937.00 KZT" results in numeric 852937.00.

Phase 4: The Generator Agent (QR Logic)
Goal: Generate the 1C-compatible image using your specific template.

Task: Protocol String Builder

Start: Create GeneratorAgent.ts.

Action: Write a function that takes amount and returns the string: AI1|KZ282|2489604|${amount}|210140004940|KZ10609|1|0.00|1.

End: Input 852937.00 returns the exact string provided in your prompt.

Task: QR Renderer

Start: Update GeneratorAgent.ts.

Action: Use the qrcode library to convert the string into a Buffer.

End: Script saves a test.png to disk; scanning it with a phone shows the correct AI1 string.

Phase 5: The Dispatcher Agent (Telegram)
Goal: Securely deliver the QR to staff.

Task: Bot Initialization

Start: Create DispatcherAgent.ts.

Action: Set up Telegraf with your bot token. Create a whitelist check for CHAT_ID.

End: Bot responds "Access Denied" to a random user and "Authorized" to you.

Task: Photo Delivery

Start: Update DispatcherAgent.ts.

Action: Write sendOrderQR(photoBuffer, orderId).

End: You receive the generated QR in your Telegram app with the order ID as a caption.

Phase 6: Orchestration & Looping
Goal: Connect all agents into a production loop.

Task: The Integration Bridge

Start: Update index.ts.

Action: Combine agents into a single flow: Scrape -> if(isNew) -> Generate -> Dispatch -> Save.

End: Running the script once successfully processes one new order from the bank cabinet to Telegram.

Task: The Scheduler

Start: Update index.ts.

Action: Use setInterval or node-cron to run the crawler every 60 seconds.

End: Logs show the bot checking the site every minute and skipping existing orders.

Phase 7: Resilience & Monitoring
Goal: Make the bot "unbreakable."

Task: Error Watchdog

Start: Update error handling in index.ts.

Action: Wrap the main loop in a try/catch. On error, send a Telegram alert to the developer.

End: Manually break the URL in .env and verify you receive a Telegram alert about the failure.