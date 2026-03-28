import { getBccCode, INSTALLMENT_MAP, isValidBccCode } from './InstallmentMapper';

/**
 * Unit tests for InstallmentMapper
 * Tests various text format variations
 */

console.log('=== Testing InstallmentMapper ===\n');

// Test cases with different text formats
const testCases = [
  { input: '12 месяцев', expected: 'KZ283', description: 'Full word "месяцев"' },
  { input: '12 месяца', expected: 'KZ283', description: 'Full word "месяца"' },
  { input: '12 месяц', expected: 'KZ283', description: 'Full word "месяц"' },
  { input: '12 мес.', expected: 'KZ283', description: 'Abbreviated "мес."' },
  { input: '12 мес', expected: 'KZ283', description: 'Abbreviated "мес" without dot' },
  { input: '12', expected: 'KZ283', description: 'Only digits' },
  { input: '3 месяца', expected: 'KZ281', description: '3 months' },
  { input: '6 месяцев', expected: 'KZ282', description: '6 months' },
  { input: '18 месяцев', expected: 'KZ284', description: '18 months' },
  { input: '24 месяца', expected: 'KZ285', description: '24 months (reserve)' },
  { input: '9 месяцев', expected: 'UNKNOWN', description: 'Unmapped period' },
  { input: 'no numbers here', expected: 'UNKNOWN', description: 'No digits' },
  { input: '', expected: 'UNKNOWN', description: 'Empty string' },
];

let passed = 0;
let failed = 0;

console.log('Running test cases:\n');

testCases.forEach((testCase, index) => {
  const result = getBccCode(testCase.input);
  const status = result === testCase.expected ? '✅ PASS' : '❌ FAIL';
  
  if (result === testCase.expected) {
    passed++;
  } else {
    failed++;
  }
  
  console.log(`${index + 1}. ${status} - ${testCase.description}`);
  console.log(`   Input: "${testCase.input}"`);
  console.log(`   Expected: ${testCase.expected}, Got: ${result}\n`);
});

// Test INSTALLMENT_MAP
console.log('=== INSTALLMENT_MAP Contents ===');
Object.entries(INSTALLMENT_MAP).forEach(([months, code]) => {
  console.log(`${months} months -> ${code}`);
});
console.log();

// Test isValidBccCode
console.log('=== Testing isValidBccCode ===');
const validationTests = [
  { code: 'KZ281', expected: true },
  { code: 'KZ283', expected: true },
  { code: 'KZ999', expected: false },
  { code: 'UNKNOWN', expected: false },
];

validationTests.forEach(test => {
  const result = isValidBccCode(test.code);
  const status = result === test.expected ? '✅' : '❌';
  console.log(`${status} isValidBccCode("${test.code}") = ${result} (expected: ${test.expected})`);
});

console.log('\n=== Test Summary ===');
console.log(`Total: ${testCases.length}`);
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Success Rate: ${((passed / testCases.length) * 100).toFixed(1)}%`);

if (failed === 0) {
  console.log('\n🎉 All tests passed!');
} else {
  console.log(`\n⚠️  ${failed} test(s) failed`);
  process.exit(1);
}
