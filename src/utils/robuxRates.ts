import type { Settings } from '@/types';

// USD per 1 Robux. Conventional values; the user can refine later.
export const ROBUX_USD_RATES: Record<Settings['robuxCashRate'], number> = {
  devex: 0.0035,
  regular: 0.0125,
  robloxPlus: 0.0125,
};

// Currency multiplier off USD. Static rates — the popup picks one of three.
export const CURRENCY_USD_RATES: Record<Settings['robuxCashCurrency'], number> = {
  USD: 1,
  GBP: 0.79,
  NOK: 10.5,
};

export function robuxToCash(
  robux: number,
  rate: Settings['robuxCashRate'],
  currency: Settings['robuxCashCurrency']
): number {
  const usd = robux * ROBUX_USD_RATES[rate];
  return usd * CURRENCY_USD_RATES[currency];
}

export function formatCash(amount: number, currency: Settings['robuxCashCurrency']): string {
  const fractionDigits = amount < 1 ? 3 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: fractionDigits,
      minimumFractionDigits: fractionDigits,
    }).format(amount);
  } catch {
    return `${amount.toFixed(fractionDigits)} ${currency}`;
  }
}
