import { describe, expect, it } from 'vitest';
import { classify, forecastDaily, reorderAdvice } from '../src/index.js';

describe('classify', () => {
  const base = { categoryId: 1, ageDays: 400 };
  it('fast, normal, slow, dead and new', () => {
    const items = [
      { ...base, productId: 1, soldMilli: 120_000, soldPaise: 4_000_000, daysSinceSale: 0 }, // cement: top
      { ...base, productId: 2, soldMilli: 30_000, soldPaise: 1_000_000, daysSinceSale: 1 },
      { ...base, productId: 3, soldMilli: 25_000, soldPaise: 900_000, daysSinceSale: 2 },
      { ...base, productId: 4, soldMilli: 1_000, soldPaise: 50_000, daysSinceSale: 20 }, // well below the category
      { ...base, productId: 5, soldMilli: 0, soldPaise: 0, daysSinceSale: 120 }, // dead
      { ...base, productId: 6, soldMilli: 0, soldPaise: 0, daysSinceSale: null, ageDays: 5 }, // just added
    ];
    const c = classify(items, { periodDays: 30, deadDays: 60 });
    expect([1, 2, 3, 4, 5, 6].map((id) => c.get(id))).toEqual(['fast', 'normal', 'normal', 'slow', 'dead', 'new']);
  });
});

describe('reorder advice', () => {
  it('shows days left and orders enough for the target after the lorry arrives', () => {
    // sells 4 bags a day, 15 in stock, supplier 3 days, target 15 days
    const a = reorderAdvice({ stockMilli: 15_000, onOrderMilli: 0, dailyMilli: 4_000, targetDays: 15, leadDays: 3 });
    expect(a).toMatchObject({ daysLeft: 3, orderNow: true, suggestMilli: 57_000 }); // 4 × 18 − 15
    expect(a.why).toContain('sells about 4 a day');
  });
  it('what is already on order counts', () => {
    const a = reorderAdvice({ stockMilli: 15_000, onOrderMilli: 60_000, dailyMilli: 4_000, targetDays: 15, leadDays: 3 });
    expect(a).toMatchObject({ orderNow: false, suggestMilli: 0 });
  });
  it('a fast mover is warned earlier than a slow one with the same stock', () => {
    const fast = reorderAdvice({ stockMilli: 20_000, onOrderMilli: 0, dailyMilli: 5_000, targetDays: 15, leadDays: 3 });
    const slow = reorderAdvice({ stockMilli: 20_000, onOrderMilli: 0, dailyMilli: 500, targetDays: 15, leadDays: 3 });
    expect(fast.orderNow).toBe(true);
    expect(slow.orderNow).toBe(false);
  });
  it('no sales: nothing to order', () => {
    expect(reorderAdvice({ stockMilli: 0, onOrderMilli: 0, dailyMilli: 0, targetDays: 15, leadDays: 3 })).toMatchObject({ daysLeft: null, suggestMilli: 0 });
  });
});

describe('seasonality', () => {
  it('nudges the recent average by last year’s pattern, capped', () => {
    expect(forecastDaily(4_000, null, null)).toBe(4_000);
    expect(forecastDaily(4_000, 6_000, 4_000)).toBe(6_000); // coming weeks were 1.5× busier last year
    expect(forecastDaily(4_000, 20_000, 4_000)).toBe(8_000); // capped at 2×
  });
});
