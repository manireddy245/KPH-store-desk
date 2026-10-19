/**
 * Stock insights: how fast each item sells, how many days of stock are left, and how much to
 * reorder. Pure maths here; the server feeds in the numbers. Every result carries the figures
 * it is based on, so the owner can trust or override it.
 */

export type Movement = 'fast' | 'normal' | 'slow' | 'dead' | 'new';

export interface ItemSales {
  productId: number;
  categoryId: number | null;
  /** quantity sold (base units, milli) in the period */
  soldMilli: number;
  /** value sold before GST (paise) in the period */
  soldPaise: number;
  /** days since the last sale; null = never sold */
  daysSinceSale: number | null;
  /** days since the product was added (new items aren't called slow) */
  ageDays: number;
}

export interface ClassifyOptions {
  periodDays: number;
  deadDays: number;
  /** share of items (by quantity and by value) counted as fast movers */
  fastShare?: number;
  /** below this share of the category's median daily sale = slow */
  slowShare?: number;
}

function median(xs: number[]) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Fast = top sellers by quantity or by value; dead = no sale for deadDays; slow = well below its category's typical sale. */
export function classify(items: ItemSales[], o: ClassifyOptions): Map<number, Movement> {
  const fastShare = o.fastShare ?? 0.2;
  const slowShare = o.slowShare ?? 0.3;
  const out = new Map<number, Movement>();
  const selling = items.filter((i) => i.soldMilli > 0);
  const n = Math.max(1, Math.ceil(selling.length * fastShare));
  const topQty = new Set([...selling].sort((a, b) => b.soldMilli - a.soldMilli).slice(0, n).map((i) => i.productId));
  const topVal = new Set([...selling].sort((a, b) => b.soldPaise - a.soldPaise).slice(0, n).map((i) => i.productId));
  const byCat = new Map<number | null, number[]>();
  for (const i of selling) byCat.set(i.categoryId, [...(byCat.get(i.categoryId) ?? []), i.soldPaise]);
  for (const i of items) {
    if (i.ageDays < Math.min(o.deadDays, o.periodDays) && i.soldMilli === 0) out.set(i.productId, 'new');
    else if (i.daysSinceSale == null || i.daysSinceSale >= o.deadDays) out.set(i.productId, i.ageDays < o.deadDays ? 'new' : 'dead');
    else if (topQty.has(i.productId) || topVal.has(i.productId)) out.set(i.productId, 'fast');
    else if (i.soldPaise < median(byCat.get(i.categoryId) ?? []) * slowShare || i.soldMilli === 0) out.set(i.productId, 'slow');
    else out.set(i.productId, 'normal');
  }
  return out;
}

export interface ReorderInput {
  stockMilli: number;
  onOrderMilli: number;
  /** average daily sale in base units (milli) */
  dailyMilli: number;
  targetDays: number;
  leadDays: number;
  /** extra days of cover so a late lorry doesn't empty the shelf */
  safetyDays?: number;
}

export interface ReorderAdvice {
  daysLeft: number | null;
  /** order now: stock (with what's on order) won't last until a new delivery arrives */
  orderNow: boolean;
  suggestMilli: number;
  /** how the suggestion was worked out, in words */
  why: string;
}

/**
 * Days left = stock ÷ daily sale. Reorder when stock + on order won't cover the supplier's lead time
 * plus a little safety; then order enough for the target days after delivery.
 */
export function reorderAdvice(i: ReorderInput, fmt: (milli: number) => string = (m) => String(m / 1000)): ReorderAdvice {
  const safety = i.safetyDays ?? 2;
  if (i.dailyMilli <= 0) {
    return { daysLeft: null, orderNow: false, suggestMilli: 0, why: 'No sales in the period, so nothing to reorder.' };
  }
  const daysLeft = Math.floor(Math.max(i.stockMilli, 0) / i.dailyMilli);
  const cover = Math.max(i.stockMilli, 0) + i.onOrderMilli;
  const needAtDelivery = i.dailyMilli * (i.leadDays + safety);
  const orderNow = cover <= needAtDelivery;
  const want = i.dailyMilli * (i.targetDays + i.leadDays) - cover;
  const suggestMilli = want > 0 ? Math.ceil(want / 1000) * 1000 : 0;
  const why = `sells about ${fmt(i.dailyMilli)} a day; ${fmt(Math.max(i.stockMilli, 0))} in stock${i.onOrderMilli ? ` + ${fmt(i.onOrderMilli)} on order` : ''}; about ${daysLeft} day${daysLeft === 1 ? '' : 's'} left; supplier takes ${i.leadDays} day${i.leadDays === 1 ? '' : 's'}; target ${i.targetDays} days of stock`;
  return { daysLeft, orderNow, suggestMilli, why };
}

/** Forecast daily sale: recent average, nudged by the same season last year when there is a year of data. */
export function forecastDaily(recentDailyMilli: number, lastYearNextDailyMilli: number | null, lastYearSameDailyMilli: number | null): number {
  if (lastYearNextDailyMilli == null || lastYearSameDailyMilli == null || lastYearSameDailyMilli <= 0) return recentDailyMilli;
  // how much busier the coming weeks were last year than the weeks just gone, capped to avoid wild swings
  const season = Math.min(2, Math.max(0.5, lastYearNextDailyMilli / lastYearSameDailyMilli));
  return Math.round(recentDailyMilli * season);
}
