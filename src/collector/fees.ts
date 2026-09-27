const USD_DIGITS = 12;

// Exact decimal string for value / 10^digits, trailing zeros trimmed.
export function formatFixed(value: bigint, digits: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(digits);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(digits, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

// Parses a non-negative decimal such as "2696.2505966583512" into an integer and its decimal places, without rounding.
export function parseDecimal(value: string): { units: bigint; digits: number } {
  if (!/^\d+(\.\d+)?$/.test(value)) throw new Error(`Invalid decimal "${value}"`);
  const [whole = "0", frac = ""] = value.split(".");
  return { units: BigInt(whole + frac), digits: frac.length };
}

export function feeEth(feeWei: bigint): string {
  return formatFixed(feeWei, 18);
}

// fee_usd = fee_wei / 1e18 * eth_usd with the full stored price, truncated to 12 decimals (PROJECT.md 22, acceptance test 5).
export function feeUsd(feeWei: bigint, ethUsd: string): string {
  const price = parseDecimal(ethUsd);
  const shift = 18 + price.digits - USD_DIGITS;
  const scaled = shift >= 0 ? (feeWei * price.units) / 10n ** BigInt(shift) : feeWei * price.units * 10n ** BigInt(-shift);
  return formatFixed(scaled, USD_DIGITS);
}
