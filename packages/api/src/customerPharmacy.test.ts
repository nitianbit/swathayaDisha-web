import { shelfOf, type StockRow } from './customerPharmacy.ts';

const A = 'a1'.repeat(12);
const B = 'b1'.repeat(12);
const row = (medicineId: string | { _id: string }, availableQty: number, retailPrice?: number, name = 'Med'): StockRow =>
  ({ _id: 'x', pharmacyId: 'p', medicineId, availableQty, retailPrice, medicine: { _id: typeof medicineId === 'string' ? medicineId : medicineId._id, name, strength: '500 mg' } });

describe('shelfOf', () => {
  it('shows one line per medicine: quantities summed, price range kept', () => {
    const shelf = shelfOf([row(A, 5, 20, 'Paracetamol'), row({ _id: A }, 3, 22, 'Paracetamol'), row(B, 4, 35, 'Cetirizine')]);
    expect(shelf).toEqual([
      { medicineId: A, name: 'Paracetamol', detail: '500 mg', availableQty: 8, minPrice: 20, maxPrice: 22 },
      { medicineId: B, name: 'Cetirizine', detail: '500 mg', availableQty: 4, minPrice: 35, maxPrice: 35 },
    ]);
  });
  it('leaves out inactive rows; a zero or missing price is not orderable (unknown)', () => {
    const shelf = shelfOf([{ ...row(A, 5, 20), isActive: false }, row(B, 3, 0)]);
    expect(shelf).toHaveLength(1);
    expect(shelf[0]).toMatchObject({ medicineId: B, minPrice: undefined });
  });
  it('leaves out rows with nothing sellable or a malformed medicine id; a missing price stays unknown', () => {
    const shelf = shelfOf([row(A, 0, 20), row('nope', 4, 10), row(B, 2)]);
    expect(shelf).toHaveLength(1);
    expect(shelf[0]).toMatchObject({ medicineId: B, availableQty: 2, minPrice: undefined });
  });
});
