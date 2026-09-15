/**
 * Splitting what the gateway charged across the hours it paid for.
 *
 * The ledger stores one row per booked hour, and those rows have to add up to the
 * single amount PayMongo actually took — not approximately, exactly. The old rule
 * divided the total evenly, which lost centavos (₱1,000 over three hours became
 * ₱999.99) and misreported each hour whenever the hours were priced differently.
 *
 * This allocates in integer centavos, in proportion to what each hour really costs,
 * and hands the unavoidable remainder to the earliest hours. Nothing is invented and
 * nothing is dropped: the sum is the charged amount, always.
 */

/** The result is parallel to the `unitCents` given, in the same order. */
export function allocateCheckoutCents(gatewayCents: number, unitCents: number[]): number[] {
  const n = unitCents.length;
  if (n === 0) return [];
  if (!Number.isFinite(gatewayCents) || gatewayCents <= 0) return new Array(n).fill(0);

  const safe = unitCents.map((c) => (Number.isFinite(c) && c > 0 ? Math.round(c) : 0));
  const basis = safe.reduce((a, b) => a + b, 0);

  /* With no usable prices to weigh against — every hour free, or the data missing —
     an even split is the only honest answer, and the remainder rule below still makes
     it add up. */
  const shares =
    basis > 0
      ? safe.map((c) => Math.floor((gatewayCents * c) / basis))
      : new Array(n).fill(Math.floor(gatewayCents / n));

  /* Whatever flooring left behind, given one centavo at a time to the earliest hours.
     Deterministic on purpose: the same checkout allocated twice must produce the same
     rows, and "the first booking gets the odd centavo" is a rule someone reading a
     receipt can be told. */
  let remainder = gatewayCents - shares.reduce((a, b) => a + b, 0);
  for (let i = 0; i < n && remainder > 0; i += 1) {
    shares[i] += 1;
    remainder -= 1;
  }
  /* Flooring can only ever leave a shortfall of less than one centavo per row, so a
     negative remainder is impossible; the guard is here so a future change to the
     weighting cannot silently start inventing money. */
  for (let i = n - 1; i >= 0 && remainder < 0; i -= 1) {
    const take = Math.min(shares[i], -remainder);
    shares[i] -= take;
    remainder += take;
  }
  return shares;
}

/** Pesos in, pesos out, for callers holding prices rather than centavos. */
export function allocateCheckoutAmounts(gatewayCents: number, unitPrices: number[]): number[] {
  return allocateCheckoutCents(
    gatewayCents,
    unitPrices.map((p) => Math.round((Number(p) || 0) * 100)),
  ).map((c) => c / 100);
}
