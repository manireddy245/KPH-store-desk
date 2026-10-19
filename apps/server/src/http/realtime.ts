import type { WebSocket } from 'ws';

/**
 * Live updates: when a bill is saved on Counter 1, every other screen hears
 * about it and refreshes stock, dashboard and lists.
 */
export type LiveEvent =
  | { type: 'invoice.created' | 'invoice.cancelled'; id: number; number: string }
  | { type: 'receipt.created' | 'receipt.cancelled'; id: number }
  | { type: 'stock.changed'; productIds: number[] }
  | { type: 'products.changed' | 'customers.changed' | 'suppliers.changed' | 'settings.changed' | 'users.changed' | 'devices.changed' | 'accounts.changed' | 'partners.changed' | 'deliveries.changed' }
  | { type: 'workspace.changed' };

export class Realtime {
  private clients = new Set<WebSocket>();

  add(ws: WebSocket) {
    this.clients.add(ws);
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  broadcast(e: LiveEvent) {
    const msg = JSON.stringify(e);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(msg);
    }
  }

  closeAll() {
    for (const ws of this.clients) ws.close();
    this.clients.clear();
  }

  get count() {
    return this.clients.size;
  }
}
