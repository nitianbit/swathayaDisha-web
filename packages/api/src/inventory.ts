import { formatYmd } from '@jansetu/i18n';
import type { ApiClient, Page } from './client.ts';
import { istDateOf } from './partnerLabs.ts';
import type { OrderStatus } from './pharmacyOrders.ts';

/** Mirrors src1/modules/pharmacyInventory (model, batchQuality.ts, sellable.ts); only fields the screens read. */
export type BatchStatus = 'active' | 'depleted' | 'expired' | 'recalled' | 'quarantined';

export interface Batch {
  _id: string;
  batchNumber: string;
  /** YYYYMMDD */
  expiryDate: string;
  /** Unreserved units in this batch. */
  availableQty: number;
  reservedQty: number;
  status: BatchStatus;
  holdReason?: string;
  heldAt?: string;
  recallReference?: string;
}

export interface MedicineRef {
  _id: string; name?: string; genericName?: string; brandName?: string; strength?: string; dosageForm?: string;
  /** r36b: on the pharmacy's stock list (a prescription medicine puts a sale under pharmacist review). */
  rx?: boolean;
}

/** Whether a stock row's medicine needs a prescription, as the stock list says (the one place that reads the field). */
export const isRxMedicine = (m: InventoryItem['medicineId']) => typeof m === 'object' && !!m && m.rx === true;

export interface InventoryItem {
  _id: string;
  medicineId: MedicineRef | string;
  availableQty: number;
  reservedQty: number;
  reorderThreshold: number;
  rackLocation?: string;
  isActive?: boolean;
  /** WQ50: what a customer pays per unit (the order is priced from it; rupees). */
  retailPrice?: number;
  batches?: Batch[];
  /** How many active refill subscriptions need this medicine soon (low-stock list only). */
  upcomingRefills?: number;
}

export interface HeldUnit { medicineId: string; medicineName?: string; batchId: string; batchNumber: string; quantity: number }
export interface ImpactedOrder { orderId: string; orderNumber?: string; status: OrderStatus; heldUnits: HeldUnit[] }

export interface QualityHoldRow {
  inventoryItemId: string;
  medicineId: string;
  medicineName?: string;
  batchId: string;
  batchNumberRaw?: string;
  expiryDateRaw?: string;
  storedQualityStatus: BatchStatus;
  availableQty: number;
  reservedQty: number;
}

export type SupplierReturnReason = 'expired' | 'damaged' | 'recalled' | 'near_expiry' | 'other';

export interface SupplierReturn {
  _id: string;
  supplierId: string;
  medicineId: string;
  batchNumber: string;
  quantity: number;
  reason: SupplierReturnReason;
  notes?: string;
  batchStatusAtReturn: BatchStatus;
  requestKey?: string;
  createdAt: string;
}

export interface SupplierReturnRequest {
  supplierId: string;
  quantity: number;
  reason: SupplierReturnReason;
  notes?: string;
  /** Same key again = the same return: the server answers with the first record (backend W2b). */
  requestKey: string;
}

export interface Dispensed { orderId: string; orderNumber?: string; customerId?: string; completedAt?: string; quantity: number; returnedQty?: number }
export interface RecallTrace { batch: Batch; openOrders: ImpactedOrder[]; dispensedTo: Dispensed[]; dispensedTruncated: boolean }

/** pharmacySuppliers SupplierDto (only the fields used). */
export interface Supplier { supplierId: string; displayName: string; state: 'active' | 'archived' }

/** States each batch action accepts (batchQuality.ts). */
export const BATCH_ACTION_FROM = {
  quarantine: ['active', 'expired'],
  release: ['quarantined'],
  supplierReturn: ['active', 'expired', 'quarantined', 'recalled'],
  recall: ['active', 'expired', 'quarantined', 'depleted'],
} as const satisfies Record<string, readonly BatchStatus[]>;

/** Orders whose held units can still move to another batch (batchQuality.ts REALLOCATABLE_ORDER_STATUSES). */
export const REALLOCATABLE_ORDER_STATUSES: readonly OrderStatus[] = ['placed', 'accepted', 'packed', 'ready_for_pickup', 'delivery_failed'];

/** Today in India as YYYYMMDD (the server's `istTodayYyyymmdd`: a batch expiring today still sells today in India). */
export const todayYyyymmdd = (now = new Date()) => istDateOf(now).replace(/-/g, '');

/** Sellable stock, the backend's rule (sellable.ts): active, unexpired batch units; legacy items without batches use availableQty. */
export function sellableQty(item: Pick<InventoryItem, 'availableQty' | 'batches'>, today = todayYyyymmdd()): number {
  const batches = item.batches ?? [];
  if (!batches.length) return Number(item.availableQty ?? 0);
  return batches.filter((b) => b.status === 'active' && String(b.expiryDate) >= today).reduce((a, b) => a + Number(b.availableQty ?? 0), 0);
}

const hex = /^[0-9a-fA-F]{24}$/;
const batchPath = (itemId: string, batchId: string) => {
  if (!hex.test(itemId) || !hex.test(batchId)) throw new Error('Invalid batch reference'); // i18n-ignore: a programming error, not shown
  return `/pharmacy-inventory/${itemId}/batches/${batchId}`;
};

export function inventoryApi(c: ApiClient) {
  return {
    list: (q: { search?: string; page?: number; limit?: number; isActive?: boolean } = {}): Promise<Page<InventoryItem>> =>
      c.page<InventoryItem>('/pharmacy-inventory', { query: { ...q, includeBatches: 'true' } }),
    lowStock: (q: { page?: number; limit?: number } = {}) =>
      c.page<InventoryItem>('/pharmacy-inventory/low-stock', { query: { ...q, includeBatches: 'true' } }),
    qualityHolds: (q: { qualityStatus?: 'recalled' | 'quarantined' | 'expired'; page?: number; limit?: number } = {}) =>
      c.page<QualityHoldRow>('/pharmacy-inventory/quality-holds', { query: { ...q } }),
    heldBatchOrders: () => c.get<ImpactedOrder[]>('/pharmacy-inventory/held-batch-orders'),
    supplierReturns: (q: { page?: number; limit?: number } = {}) =>
      c.page<SupplierReturn>('/pharmacy-inventory/supplier-returns', { query: { ...q } }),
    quarantine: (itemId: string, batchId: string, reason: string) =>
      c.post<{ batch: Batch; impactedOrders: ImpactedOrder[] }>(`${batchPath(itemId, batchId)}/quarantine`, { body: { reason } }),
    release: (itemId: string, batchId: string, body: { writeOffQty: number; reason: string }) =>
      c.post<{ batch: Batch }>(`${batchPath(itemId, batchId)}/release`, { body }),
    supplierReturn: (itemId: string, batchId: string,
      body: SupplierReturnRequest) =>
      c.post<SupplierReturn & { duplicate?: boolean }>(`${batchPath(itemId, batchId)}/supplier-return`, { body }),
    recall: (itemId: string, batchId: string, body: { reason: string; reference?: string }) =>
      c.post<RecallTrace & { impactedOrders: ImpactedOrder[] }>(`${batchPath(itemId, batchId)}/recall`, { body }),
    recallTrace: (itemId: string, batchId: string) => c.get<RecallTrace>(`${batchPath(itemId, batchId)}/recall-trace`),
    suppliers: () => c.page<Supplier>('/pharmacy-suppliers', { query: { state: 'active', limit: 50 } }),
  };
}

export const medicineName = (m: InventoryItem['medicineId']) =>
  typeof m === 'object' && m ? [m.name ?? m.brandName ?? m.genericName ?? m._id, m.strength].filter(Boolean).join(' ') : String(m);

/** YYYYMMDD → "30 Jun 2027". */
export function formatExpiry(yyyymmdd: string | undefined): string {
  if (!yyyymmdd || !/^\d{8}$/.test(yyyymmdd)) return yyyymmdd || '—';
  return formatYmd(yyyymmdd);
}
