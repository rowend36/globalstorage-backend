/** Monetary values are integer minor units (cents); floating point amounts are forbidden. */
export type Money = Readonly<{ amount: bigint; currency: string }>;
export const money = (amount: bigint, currency: string): Money => ({
  amount,
  currency: currency.toUpperCase(),
});
