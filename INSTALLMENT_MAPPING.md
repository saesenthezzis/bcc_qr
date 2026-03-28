# Installment Period Mapping Implementation

## Overview
This implementation adds dynamic BCC code mapping based on installment periods parsed from the bank portal.

## Components

### 1. InstallmentMapper (`src/utils/InstallmentMapper.ts`)

**INSTALLMENT_MAP Constant:**
```typescript
const INSTALLMENT_MAP: Record<string, string> = {
  "3": "KZ281",   // 3 months
  "6": "KZ282",   // 6 months
  "12": "KZ283",  // 12 months
  "18": "KZ284",  // 18 months
  "24": "KZ285"   // 24 months (reserve)
};
```

**getBccCode Function:**
- Extracts digits from parsed text (e.g., "12 месяцев" → "12")
- Maps to corresponding BCC code
- Returns "UNKNOWN" if no mapping found
- Logs: `[LOG] Срок: 12 мес. -> Код 1С: KZ283`

**Supported Text Formats:**
- ✅ "12 месяцев" (full word)
- ✅ "12 месяца" (full word)
- ✅ "12 месяц" (full word)
- ✅ "12 мес." (abbreviated with dot)
- ✅ "12 мес" (abbreviated without dot)
- ✅ "12" (digits only)

### 2. Generator Agent (`src/agents/Generator.ts`)

**Updated Methods:**
- `generateQR(amount: number, installmentPeriod?: string): Promise<Buffer>`
- `generateQRToFile(amount: number, orderId: string, installmentPeriod?: string): Promise<string>`

**Behavior:**
- Accepts optional `installmentPeriod` parameter
- Uses `getBccCode()` to determine BCC code dynamically
- Falls back to default `KZ284` if period not provided or unknown
- Logs warnings for unknown periods

**Protocol String Format:**
```
AI1|{BCC_CODE}|{MERCHANT_ID}|{AMOUNT}|{ACCOUNT}|{BANK_CODE}|1|0.00|1
```

### 3. Test Implementation (`src/index.test.ts`)

**Enhanced Features:**
- Parses installment period from sidebar using regex: `/(\d+)\s*(месяц|месяца|месяцев|мес\.?)/i`
- Calls `getBccCode()` to get 1C code
- Generates test QR with dynamic BCC code
- Saves QR to `storage/test_qr_{BCC_CODE}.png`
- Logs mapping result in console

### 4. Unit Tests (`src/utils/InstallmentMapper.test.ts`)

**Test Coverage:**
- 13 test cases covering all text format variations
- Validates INSTALLMENT_MAP contents
- Tests `isValidBccCode()` function
- 100% success rate

**Run Tests:**
```bash
npx ts-node src/utils/InstallmentMapper.test.ts
```

## Usage Example

```typescript
import { getBccCode } from './utils/InstallmentMapper';
import { GeneratorAgent } from './agents/Generator';

// Parse period from sidebar
const installmentPeriod = "12 мес.";

// Get BCC code
const bccCode = getBccCode(installmentPeriod);
// Output: [LOG] Срок: 12 мес. -> Код 1С: KZ283

// Generate QR with dynamic code
const generator = new GeneratorAgent();
const qrBuffer = await generator.generateQR(100000, installmentPeriod);
// Protocol: AI1|KZ283|2489604|100000.00|210140004940|KZ10609|1|0.00|1
```

## Future Enhancements

To add new installment periods:
1. Add mapping to `INSTALLMENT_MAP` in `InstallmentMapper.ts`
2. No other code changes needed - fully extensible

Example:
```typescript
const INSTALLMENT_MAP: Record<string, string> = {
  "3": "KZ281",
  "6": "KZ282",
  "9": "KZ286",  // New period
  "12": "KZ283",
  // ...
};
```

## Error Handling

- **Unknown Period:** Returns "UNKNOWN", logs warning, uses default code
- **No Digits Found:** Returns "UNKNOWN", logs warning
- **Empty String:** Returns "UNKNOWN", logs warning

All edge cases are handled gracefully with appropriate logging for debugging.
