import type { RemoteItem } from '../api/schemas';
import type { SqlDb } from './driver';
import { ItemRepo } from './items';

const WORDS = ['Jasmine', 'Basmati', 'Udon', 'Soba', 'Kimchi', 'Miso', 'Tofu', 'Gochujang', 'Sesame', 'Chili', 'Mango', 'Lychee', 'Pocky', 'Ramen', 'Nori', 'Matcha', 'Oolong', 'Panko', 'Hoisin', 'Sriracha'];
const KINDS = ['Rice', 'Noodles', 'Sauce', 'Snack', 'Tea', 'Paste', 'Candy', 'Drink', 'Oil', 'Flour'];
const SIZES = ['100g', '250g', '500g', '1kg', '2lb', '5lb', '12oz', '24oz', '6-pack', '1L'];

/** Dev-only: deterministic fake catalog for performance testing (spec §6). Never syncs to Clover. */
export class Seeder {
  static fakeItems(count: number, seed = 1): RemoteItem[] {
    let s = seed;
    const rand = () => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    return Array.from({ length: count }, (_, i) => ({
      id: `SEED_${i.toString().padStart(6, '0')}`,
      name: `${pick(WORDS)} ${pick(KINDS)} ${pick(SIZES)} #${i}`,
      sku: `SEED-${i}`,
      code: (900000000000 + i).toString(),
      priceCents: 99 + Math.floor(rand() * 4900),
      costCents: rand() < 0.5 ? 50 + Math.floor(rand() * 2000) : null,
      categoryId: null,
      stockQty: Math.floor(rand() * 60) - 5,
      modifiedTime: 1_700_000_000_000 + i,
      deleted: false,
    }));
  }

  static async seed(db: SqlDb, count = 15_000, now = Date.now()): Promise<void> {
    await ItemRepo.upsertItems(db, Seeder.fakeItems(count), now);
  }
}
