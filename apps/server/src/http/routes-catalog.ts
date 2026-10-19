import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../services/common.js';
import { createCustomer, createSupplier, customerStatement, listCustomers, listSuppliers, updateCustomer, updateSupplier } from '../services/parties.js';
import {
  adjustStock,
  createProduct,
  deleteProduct,
  findOrCreateBrand,
  getProduct,
  listCategories,
  listProducts,
  reconcileStock,
  saveCategory,
  stockCard,
  updateProduct,
} from '../services/products.js';
import { ctxOf, type Shared } from './app.js';

const int = z.number().int();
const money = z.number().int().min(0);
const id = z.coerce.number().int().positive();
const disc = { maxDiscType: z.enum(['pct', 'amt']).nullable().optional(), maxDiscValue: money.nullable().optional() };

const productBody = z.object({
  sku: z.string().optional(),
  name: z.string().optional(),
  categoryId: int.nullable().optional(),
  brandId: int.nullable().optional(),
  brandName: z.string().optional(),
  unitCode: z.string().optional(),
  hsn: z.string().nullable().optional(),
  gstRateBp: z.number().int().min(0).max(10000).optional(),
  salePricePaise: money.optional(),
  costPricePaise: money.nullable().optional(),
  mrpPaise: money.nullable().optional(),
  reorderLevelMilli: money.nullable().optional(),
  active: z.boolean().optional(),
  openingQtyMilli: money.optional(),
  ...disc,
});

const customerBody = z.object({
  name: z.string().optional(),
  phone: z.string().nullable().optional(),
  gstin: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  stateCode: z.string().optional(),
  creditLimitPaise: money.nullable().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
  openingBalancePaise: z.number().int().optional(),
});

const supplierBody = z.object({
  name: z.string().optional(),
  phone: z.string().nullable().optional(),
  category: z.string().nullable().optional(),
  gstin: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  leadTimeDays: z.number().int().min(0).nullable().optional(),
  active: z.boolean().optional(),
  openingBalancePaise: z.number().int().optional(),
});

export async function registerCatalogRoutes(app: FastifyInstance, { db, live }: Shared) {
  // ---------------------------------------------------------------- products
  app.get('/api/products', async (req) => {
    const q = z
      .object({ search: z.string().optional(), categoryId: id.optional(), stock: z.enum(['low', 'out', 'ok']).optional(), includeInactive: z.coerce.boolean().optional() })
      .parse(req.query);
    return listProducts(db.app, ctxOf(req), q);
  });

  app.get('/api/products/:id', async (req) => getProduct(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));

  app.post('/api/products', async (req) => {
    const b = productBody.extend({ sku: z.string().min(1), name: z.string().min(2), unitCode: z.string().min(1) }).parse(req.body);
    const { brandName, ...input } = b;
    if (brandName?.trim() && !input.brandId) input.brandId = await findOrCreateBrand(db.app, brandName);
    const r = await createProduct(db.app, ctxOf(req), input);
    live.broadcast({ type: 'products.changed' });
    return r;
  });

  app.patch('/api/products/:id', async (req) => {
    const { id: pid } = z.object({ id }).parse(req.params);
    const { brandName, ...input } = productBody.parse(req.body);
    if (brandName?.trim() && input.brandId === undefined) input.brandId = await findOrCreateBrand(db.app, brandName);
    const r = await updateProduct(db.app, ctxOf(req), pid, input);
    live.broadcast({ type: 'products.changed' });
    return r;
  });

  app.delete('/api/products/:id', async (req) => {
    const r = await deleteProduct(db.app, ctxOf(req), z.object({ id }).parse(req.params).id);
    live.broadcast({ type: 'products.changed' });
    return r;
  });

  app.post('/api/products/:id/adjust', async (req) => {
    const { id: pid } = z.object({ id }).parse(req.params);
    const b = z.object({ newQtyMilli: money.optional(), deltaMilli: int.optional(), reason: z.string() }).parse(req.body);
    const r = await adjustStock(db.app, ctxOf(req), pid, b);
    live.broadcast({ type: 'stock.changed', productIds: [pid] });
    return r;
  });

  app.get('/api/products/:id/movements', async (req) => stockCard(db.app, ctxOf(req), z.object({ id }).parse(req.params).id));

  app.get('/api/stock/reconcile', async (req) => {
    requirePerm(ctxOf(req), 'reports.view');
    return reconcileStock(db.app);
  });

  // ---------------------------------------------------------------- categories, brands, units
  app.get('/api/categories', async () => listCategories(db.app));
  app.post('/api/categories', async (req) => {
    const b = z.object({ name: z.string(), defaultGstBp: z.number().int().min(0).max(10000).optional(), ...disc }).parse(req.body);
    return saveCategory(db.app, ctxOf(req), null, b);
  });
  app.patch('/api/categories/:id', async (req) => {
    const b = z.object({ name: z.string().optional(), defaultGstBp: z.number().int().min(0).max(10000).optional(), active: z.boolean().optional(), ...disc }).parse(req.body);
    const r = await saveCategory(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, b);
    live.broadcast({ type: 'products.changed' });
    return r;
  });
  app.get('/api/brands', async () => db.app`select id, name from brands order by lower(name)`);
  app.get('/api/units', async () => db.app`select code, name from units order by code`);

  // ---------------------------------------------------------------- customers
  app.get('/api/customers', async (req) => {
    const q = z.object({ search: z.string().optional(), withBalanceOnly: z.coerce.boolean().optional(), includeInactive: z.coerce.boolean().optional() }).parse(req.query);
    return listCustomers(db.app, q);
  });
  app.get('/api/customers/:id', async (req) => customerStatement(db.app, z.object({ id }).parse(req.params).id));
  app.post('/api/customers', async (req) => {
    const b = customerBody.extend({ name: z.string().min(2) }).parse(req.body);
    const r = await createCustomer(db.app, ctxOf(req), b);
    live.broadcast({ type: 'customers.changed' });
    return r;
  });
  app.patch('/api/customers/:id', async (req) => {
    const r = await updateCustomer(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, customerBody.parse(req.body));
    live.broadcast({ type: 'customers.changed' });
    return r;
  });

  // ---------------------------------------------------------------- suppliers
  app.get('/api/suppliers', async (req) => {
    const q = z.object({ search: z.string().optional(), includeInactive: z.coerce.boolean().optional() }).parse(req.query);
    return listSuppliers(db.app, q);
  });
  app.post('/api/suppliers', async (req) => {
    const b = supplierBody.extend({ name: z.string().min(2) }).parse(req.body);
    const r = await createSupplier(db.app, ctxOf(req), b);
    live.broadcast({ type: 'suppliers.changed' });
    return r;
  });
  app.patch('/api/suppliers/:id', async (req) => {
    const r = await updateSupplier(db.app, ctxOf(req), z.object({ id }).parse(req.params).id, supplierBody.parse(req.body));
    live.broadcast({ type: 'suppliers.changed' });
    return r;
  });
}
