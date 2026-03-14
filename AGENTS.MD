# Agents.md: CreditBridge RPA System

## 1. Surveillance Agent (The "Eyes")
- **Stack:** Crawlee + Playwright.
- **Task:** Login to the bank portal, navigate to the transaction table, and extract:
  - `external_id`: The unique order number.
  - `amount`: The numeric value of the credit (must be cleaned of currency symbols).
- **Session:** Must persist cookies in the `storage` directory to avoid frequent logins.

## 2. Registry Agent (The "Brain")
- **Stack:** Supabase (Postgres).
- **Task:** Prevent duplicate processing.
- **Functionality:** - `check(id)`: Verify if the order exists.
  - `register(id, amount)`: Save new order with status `PROCESSED`.

## 3. Generator Agent (The "Translator")
- **Stack:** `qrcode` npm library.
- **Task:** Generate the static-template QR code.
- **Protocol Template:** `AI1|KZ282|2489604|${amount}.00|210140004940|KZ10609|1|0.00|1`
- **Logic:** Only inject the `amount` into the 4th segment. The rest of the string remains static as per the merchant's configuration.

## 4. Dispatcher Agent (The "Messenger")
- **Stack:** Telegraf (Telegram Bot API).
- **Task:** Deliver the QR to the store staff.
- **Security:** Use a whitelist of `CHAT_ID`s to ensure the QR codes only go to authorized managers.

Coding Instructions

- Write the absolute minimum code required
- No sweeping changes
- No unrelated edits - focus on just the task you're on
- Make code precise, modular, testable
- Don't break existing functionality
- If I need to do anything (e.g. Supabase/AWS config), tell me clearly