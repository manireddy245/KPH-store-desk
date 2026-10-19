import { ALL_PERMISSIONS, istDate, istDayRange } from '@kph/core';
import type { Sql } from '../db/connect.js';
import { createInvoice, createReceipt, type PaymentMode } from './billing.js';
import type { Ctx } from './common.js';
import { createCustomer, createSupplier } from './parties.js';
import { createProduct, findOrCreateBrand } from './products.js';
import { setSettings } from './settings.js';
import { createUser } from './users.js';

/**
 * SAMPLE DATA ONLY — loaded into the separate "storedesk_sample" database, which
 * always shows an orange SAMPLE DATA banner. Real data lives in "storedesk_live",
 * which starts empty.
 *
 * Sample logins (test values for the sample workspace only):
 *   Guru Mani (Admin) PIN 1234 · Ravi (Counter staff) PIN 2222 · Suresh (Stock staff) PIN 3333
 */
export const SAMPLE_USERS = [
  { name: 'Guru Mani', roleId: 'admin', pin: '1234' },
  { name: 'Ravi', roleId: 'counter', pin: '2222' },
  { name: 'Suresh', roleId: 'stock', pin: '3333' },
];

type Disc = { type: 'pct' | 'amt'; value: number } | null;
const pct = (n: number): Disc => ({ type: 'pct', value: Math.round(n * 100) });

const CATEGORIES: { name: string; disc: Disc }[] = [
  { name: 'Paints', disc: pct(8) },
  { name: 'Putty & Primers', disc: pct(5) },
  { name: 'Cement', disc: pct(1) },
  { name: 'Tile Adhesives', disc: pct(3) },
  { name: 'Steel', disc: pct(1) },
  { name: 'Pipes & Fittings', disc: pct(5) },
  { name: 'Sanitaryware', disc: pct(5) },
  { name: 'Electricals', disc: pct(5) },
  { name: 'Hardware', disc: pct(10) },
];

// [sku, name, category, brand, unit, hsn, sale ₹ excl GST, cost ₹, opening qty, reorder, max disc override]
type P = [string, string, string, string, string, string, number, number, number, number, Disc?];
const PRODUCTS: P[] = [
  ['SMP-BO-EMU-01', 'Birla Opus One Pure Elegance Emulsion 1L', 'Paints', 'Birla Opus', 'tin', '3209', 520, 430, 40, 10],
  ['SMP-BO-EMU-04', 'Birla Opus One Pure Elegance Emulsion 4L', 'Paints', 'Birla Opus', 'tin', '3209', 1980, 1640, 25, 6],
  ['SMP-BO-EMU-10', 'Birla Opus One Pure Elegance Emulsion 10L', 'Paints', 'Birla Opus', 'bucket', '3209', 4750, 3950, 12, 4],
  ['SMP-BO-EMU-20', 'Birla Opus One Pure Elegance Emulsion 20L', 'Paints', 'Birla Opus', 'bucket', '3209', 9200, 7650, 6, 2],
  ['SMP-BO-EXT-20', 'Birla Opus Style Exterior Emulsion 20L', 'Paints', 'Birla Opus', 'bucket', '3209', 7400, 6150, 8, 3],
  ['SMP-BO-ENM-01', 'Birla Opus Enamel Gloss White 1L', 'Paints', 'Birla Opus', 'tin', '3208', 410, 335, 30, 8],
  ['SMP-BO-PRM-20', 'Birla Opus Interior Primer 20L', 'Putty & Primers', 'Birla Opus', 'bucket', '3209', 3100, 2560, 10, 3],
  ['SMP-BW-PUT-40', 'Birla White WallCare Putty 40kg', 'Putty & Primers', 'Birla White', 'bag', '3214', 950, 800, 60, 20],
  ['SMP-BW-PUT-20', 'Birla White WallCare Putty 20kg', 'Putty & Primers', 'Birla White', 'bag', '3214', 500, 420, 40, 10],
  ['SMP-EX-PUT-40', 'Excel Wall Putty 40kg', 'Putty & Primers', 'Excel', 'bag', '3214', 720, 600, 50, 15],
  ['SMP-UT-OPC-53', 'UltraTech OPC 53 Grade Cement 50kg', 'Cement', 'UltraTech', 'bag', '2523', 330, 305, 300, 100, { type: 'amt', value: 300 }],
  ['SMP-UT-PPC-50', 'UltraTech PPC Cement 50kg', 'Cement', 'UltraTech', 'bag', '2523', 315, 292, 400, 120, { type: 'amt', value: 300 }],
  ['SMP-UT-SUP-50', 'UltraTech Super Cement 50kg', 'Cement', 'UltraTech', 'bag', '2523', 345, 318, 150, 60],
  ['SMP-UT-TF-20', 'UltraTech Tilefixo NT Tile Adhesive 20kg', 'Tile Adhesives', 'UltraTech', 'bag', '3214', 560, 470, 45, 15],
  ['SMP-UT-TF-CT1', 'UltraTech Tilefixo CT1 Adhesive 20kg', 'Tile Adhesives', 'UltraTech', 'bag', '3214', 640, 535, 30, 10],
  // Steel is stocked and sold in rods; bought in tonnes (rods per tonne set per size).
  ['SMP-JSW-08', 'JSW Neosteel TMT 8mm rod', 'Steel', 'JSW', 'rod', '7214', 294, 270, 527, 170],
  ['SMP-JSW-10', 'JSW Neosteel TMT 10mm rod', 'Steel', 'JSW', 'rod', '7214', 452, 415, 405, 135],
  ['SMP-JSW-12', 'JSW Neosteel TMT 12mm rod', 'Steel', 'JSW', 'rod', '7214', 645, 592, 375, 112],
  ['SMP-JSW-16', 'JSW Neosteel TMT 16mm rod', 'Steel', 'JSW', 'rod', '7214', 1138, 1043, 105, 42],
  ['SMP-AS-CPVC-05', 'Astral CPVC Pipe 1/2" (3m)', 'Pipes & Fittings', 'Astral', 'length', '3917', 290, 235, 80, 25],
  ['SMP-AS-CPVC-075', 'Astral CPVC Pipe 3/4" (3m)', 'Pipes & Fittings', 'Astral', 'length', '3917', 440, 360, 60, 20],
  ['SMP-AS-ELB-05', 'Astral CPVC Elbow 1/2"', 'Pipes & Fittings', 'Astral', 'pcs', '3917', 14, 10, 500, 100],
  ['SMP-SU-PVC-4', 'Sudhakar PVC Pipe 4" 6kg (6m)', 'Pipes & Fittings', 'Sudhakar', 'length', '3917', 1150, 960, 30, 10],
  ['SMP-SU-PVC-1', 'Sudhakar PVC Pipe 1" (6m)', 'Pipes & Fittings', 'Sudhakar', 'length', '3917', 310, 250, 50, 15],
  ['SMP-SA-EWC', 'Sara EWC Floor Mount Commode', 'Sanitaryware', 'Sara', 'pcs', '6910', 3600, 2900, 8, 3],
  ['SMP-SA-WB', 'Sara Wash Basin with Pedestal', 'Sanitaryware', 'Sara', 'set', '6910', 2100, 1700, 6, 2],
  ['SMP-SA-IND', 'Sara Indian Pan', 'Sanitaryware', 'Sara', 'pcs', '6910', 950, 760, 10, 3],
  ['SMP-UV-W15', 'Ultra Volt FR Wire 1.5 sq mm (90m)', 'Electricals', 'Ultra Volt', 'coil', '8544', 1450, 1200, 25, 8],
  ['SMP-UV-W25', 'Ultra Volt FR Wire 2.5 sq mm (90m)', 'Electricals', 'Ultra Volt', 'coil', '8544', 2300, 1910, 20, 6],
  ['SMP-GM-W10', 'Gold Medal FR Wire 1.0 sq mm (90m)', 'Electricals', 'Gold Medal', 'coil', '8544', 980, 810, 15, 5],
  ['SMP-GM-SW6', 'Gold Medal 6A Switch', 'Electricals', 'Gold Medal', 'pcs', '8536', 38, 28, 200, 50],
  ['SMP-GM-SKT6', 'Gold Medal 6A Socket', 'Electricals', 'Gold Medal', 'pcs', '8536', 55, 41, 150, 40],
  ['SMP-CND-20', 'PVC Conduit Pipe 20mm (3m)', 'Electricals', 'Astral', 'length', '3917', 48, 36, 300, 80],
  ['SMP-HW-NAIL3', 'Wire Nails 3 inch', 'Hardware', 'Generic', 'kg', '7317', 95, 74, 60, 15],
  ['SMP-HW-HINGE4', 'SS Butt Hinge 4 inch', 'Hardware', 'Generic', 'pcs', '8302', 65, 45, 120, 30],
  ['SMP-HW-BRUSH4', 'Paint Brush 4 inch', 'Hardware', 'Generic', 'pcs', '9603', 85, 55, 80, 20],
  ['SMP-HW-ROLLER9', 'Paint Roller 9 inch', 'Hardware', 'Generic', 'pcs', '9603', 210, 150, 40, 10],
  ['SMP-HW-SAND', 'Sand Paper (sheet)', 'Hardware', 'Generic', 'pcs', '6805', 12, 7, 400, 100],
  ['SMP-HW-MTAPE', 'Masking Tape 1 inch', 'Hardware', 'Generic', 'pcs', '4821', 45, 30, 4, 20],
  ['SMP-HW-PADLOCK', 'Padlock 50mm', 'Hardware', 'Generic', 'pcs', '8301', 240, 180, 0, 5],
];

/** Extra units for sample products: steel bought by the tonne, wire by the metre too. */
const SAMPLE_UNITS: Record<string, { unitCode: string; factorNum: number; factorDen?: number; forSale?: boolean }[]> = {
  'SMP-JSW-08': [{ unitCode: 'tonne', factorNum: 211, forSale: false }],
  'SMP-JSW-10': [{ unitCode: 'tonne', factorNum: 135, forSale: false }],
  'SMP-JSW-12': [{ unitCode: 'tonne', factorNum: 94, forSale: false }],
  'SMP-JSW-16': [{ unitCode: 'tonne', factorNum: 53, forSale: false }],
};
/** Pack contents (litres) for paint reports. */
const SAMPLE_CONTENTS: Record<string, number> = { 'SMP-BO-EMU-01': 1, 'SMP-BO-EMU-04': 4, 'SMP-BO-EMU-10': 10, 'SMP-BO-EMU-20': 20, 'SMP-BO-EXT-20': 20, 'SMP-BO-ENM-01': 1, 'SMP-BO-PRM-20': 20 };

const CUSTOMERS = [
  { name: 'Srinivasa Reddy (Contractor)', phone: '9848012345', address: 'Musunuru, Kavali', creditLimitPaise: 20000000, openingBalancePaise: 4550000 },
  { name: 'K. Venkateswarlu (Mason)', phone: '9866023456', address: 'Kavali', creditLimitPaise: 5000000 },
  { name: 'P. Ramesh (Painter)', phone: '9963034567', address: 'Bogole', creditLimitPaise: 3000000, openingBalancePaise: 820000 },
  { name: 'Lakshmi Constructions', phone: '9989045678', address: 'Allur Road, Kavali', gstin: '37AABCL1234F1ZX', creditLimitPaise: 50000000 },
  { name: 'M. Sudhakar (House owner)', phone: '9177056789', address: 'Gowravaram' },
  { name: 'S. Naresh (Electrician)', phone: '9550067890', address: 'Kavali', creditLimitPaise: 2000000 },
];

const SUPPLIERS = [
  { name: 'Birla Opus Paints (Grasim) — Nellore depot', phone: '9000011111', category: 'Paints', leadTimeDays: 3 },
  { name: 'UltraTech Cement — Nellore dealer', phone: '9000022222', category: 'Cement', leadTimeDays: 2 },
  { name: 'JSW Steel distributor, Nellore', phone: '9000033333', category: 'Steel', leadTimeDays: 4 },
  { name: 'Astral Pipes — Vijayawada', phone: '9000044444', category: 'Pipes', leadTimeDays: 5 },
  { name: 'Sri Sai Electricals (Ultra Volt / Gold Medal)', phone: '9000055555', category: 'Electricals', leadTimeDays: 3 },
];

export async function seedSample(sql: Sql) {
  await setSettings(sql, {
    storeName: 'Kanakapatnam Paints and Hardwares',
    storeAddress: 'Main Road, Kavali, SPSR Nellore Dist., Andhra Pradesh',
    storePhone: '00000 00000',
    storeGstin: '37AAAAA0000A1Z1',
  });
  const userIds: number[] = [];
  for (const u of SAMPLE_USERS) userIds.push((await createUser(sql, null, u)).id);
  const admin: Ctx = { userId: userIds[0]!, deviceId: null, permissions: ALL_PERMISSIONS };
  const counter: Ctx = { userId: userIds[1]!, deviceId: null, permissions: ['billing.create', 'payments.receive', 'customers.manage'] };

  const catIds = new Map<string, number>();
  for (const c of CATEGORIES) {
    const [r] = await sql<{ id: number }[]>`
      insert into categories (name, max_disc_type, max_disc_value) values (${c.name}, ${c.disc?.type ?? null}, ${c.disc?.value ?? null}) returning id`;
    catIds.set(c.name, r!.id);
  }
  const productIds: number[] = [];
  for (const [sku, name, cat, brand, unit, hsn, sale, cost, qty, reorder, disc] of PRODUCTS) {
    const { id } = (await createProduct(
      sql,
      admin,
      {
        sku,
        name,
        categoryId: catIds.get(cat)!,
        brandId: await findOrCreateBrand(sql, brand),
        unitCode: unit,
        hsn,
        gstRateBp: 1800,
        salePricePaise: Math.round(sale * 100),
        costPricePaise: Math.round(cost * 100),
        openingQtyMilli: qty * 1000,
        reorderLevelMilli: reorder * 1000,
        maxDiscType: disc?.type ?? null,
        maxDiscValue: disc?.value ?? null,
        units: SAMPLE_UNITS[sku],
        contentsMilli: SAMPLE_CONTENTS[sku] ? SAMPLE_CONTENTS[sku]! * 1000 : null,
        contentsUnit: SAMPLE_CONTENTS[sku] ? 'ltr' : null,
      },
      { isSample: true },
    ))!;
    productIds.push(id);
  }
  const customerIds: number[] = [];
  for (const c of CUSTOMERS) customerIds.push((await createCustomer(sql, admin, c, { isSample: true })).id);
  for (const s of SUPPLIERS) await createSupplier(sql, admin, s, { isSample: true });

  // About a month of history so the dashboard and reports have something to show.
  let seed = 42;
  const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
  const now = Date.now();
  for (let day = 29; day >= 0; day--) {
    const bills = 2 + rnd(5);
    for (let b = 0; b < bills; b++) {
      // shop hours: first bill around 9:30 am India time, then every hour or so
      const dayStart = istDayRange(istDate(new Date(now - day * 86400000))).from.getTime();
      const at = new Date(dayStart + 9.5 * 3600000 + b * 75 * 60000 + rnd(40) * 60000);
      if (at.getTime() > now) continue;
      const lines = Array.from({ length: 1 + rnd(3) }, () => {
        const idx = rnd(productIds.length - 1); // never the padlock (out of stock)
        const isBulk = PRODUCTS[idx]![4] === 'kg' || PRODUCTS[idx]![4] === 'bag' || PRODUCTS[idx]![4] === 'rod';
        return { productId: productIds[idx]!, qtyMilli: (1 + rnd(isBulk ? 10 : 3)) * 1000, discountBp: rnd(3) === 0 ? 100 : 0 };
      });
      const uniq = [...new Map(lines.map((l) => [l.productId, l])).values()];
      const modes: PaymentMode[] = ['cash', 'cash', 'upi', 'upi', 'card', 'credit'];
      const mode = modes[rnd(modes.length)]!;
      const customerId = mode === 'credit' || rnd(2) === 0 ? customerIds[rnd(customerIds.length)]! : null;
      try {
        await createInvoice(sql, b % 2 ? counter : admin, { customerId, paymentMode: mode, lines: uniq }, { at });
      } catch {
        // skip lines that ran out of stock in the simulation
      }
    }
    if (day % 6 === 0) {
      const receiptAt = istDayRange(istDate(new Date(now - day * 86400000))).from.getTime() + 11 * 3600000;
      if (receiptAt <= now) await createReceipt(sql, counter, { customerId: customerIds[0]!, mode: 'upi', amountPaise: 1500000, reference: 'Sample UPI' }, { at: new Date(receiptAt) });
    }
  }
}
