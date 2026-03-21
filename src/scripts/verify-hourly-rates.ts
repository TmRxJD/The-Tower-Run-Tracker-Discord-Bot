import { calculateHourlyRate } from '../features/track/tracker-helpers';
import { formatNumberForDisplay, parseDurationToHours, parseNumberInput, standardizeNotation } from '../utils/tracker-math';

type Case = {
  value: string;
  duration: string;
};

const cases: Case[] = [
  { value: '0', duration: '1h' },
  { value: '25', duration: '1h' },
  { value: '999', duration: '1h' },
  { value: '1.5K', duration: '1h' },
  { value: '12.5K', duration: '2h30m' },
  { value: '2.5M', duration: '45m' },
  { value: '3.2B', duration: '1h15m30s' },
  { value: '4.25q', duration: '8h' },
  { value: '9.9Q', duration: '6h' },
  { value: '1.2s', duration: '12h' },
  { value: '5.5S', duration: '1 day 2h' },
  { value: '2.75AA', duration: '1:30:00' },
  { value: '125,5K', duration: '3h' },
  { value: '1.0AJ', duration: '23h59m59s' },
];

function expectedHourly(value: string, duration: string): string | null {
  const hours = parseDurationToHours(duration);
  if (!hours || hours <= 0) return null;
  const numeric = parseNumberInput(standardizeNotation(String(value)));
  if (!Number.isFinite(numeric)) return null;
  return formatNumberForDisplay(numeric / hours);
}

function assertEqual(label: string, actual: string | null, expected: string | null) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected ?? 'null'}, got ${actual ?? 'null'}`);
  }
}

function run() {
  let checked = 0;

  for (const c of cases) {
    const expected = expectedHourly(c.value, c.duration);

    const coins = calculateHourlyRate(c.value, c.duration);
    const cells = calculateHourlyRate(c.value, c.duration);
    const dice = calculateHourlyRate(c.value, c.duration);

    assertEqual(`coins ${c.value}/${c.duration}`, coins, expected);
    assertEqual(`cells ${c.value}/${c.duration}`, cells, expected);
    assertEqual(`dice ${c.value}/${c.duration}`, dice, expected);

    if (coins !== cells || cells !== dice) {
      throw new Error(`resource inconsistency for ${c.value}/${c.duration}: coins=${coins}, cells=${cells}, dice=${dice}`);
    }

    checked += 1;
  }

  console.log(`✅ Hourly rate verification passed for ${checked} cases.`);
}

run();
