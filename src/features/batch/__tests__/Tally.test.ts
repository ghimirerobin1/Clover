import { Beep } from '../../../lib/beep';
import { ScanDebouncer } from '../../scan/LookupChain';
import { Tally, TallyController, useTallyStore } from '../Tally';

const rice = { id: 'RICE', name: 'Jasmine Rice 20lb' };
const ramen = { id: 'RAMEN', name: 'Shin Ramyun' };

describe('Tally (continuous scan)', () => {
  it('same item increments, new item goes on top', () => {
    let rows = Tally.add([], rice);
    rows = Tally.add(rows, rice);
    rows = Tally.add(rows, ramen);
    rows = Tally.add(rows, rice);
    expect(rows.map(Tally.label)).toEqual(['Shin Ramyun ×1', 'Jasmine Rice 20lb ×3']);
    expect(Tally.total(rows)).toBe(4);
  });

  it('decrement drops the row at zero; remove drops it', () => {
    let rows = Tally.add(Tally.add([], rice), rice);
    rows = Tally.decrement(rows, 'RICE');
    expect(rows).toEqual([{ itemId: 'RICE', itemName: rice.name, count: 1 }]);
    expect(Tally.decrement(rows, 'RICE')).toEqual([]);
    expect(Tally.remove(Tally.add(rows, ramen), 'RICE').map((r) => r.itemId)).toEqual(['RAMEN']);
  });

  it('is immutable', () => {
    const rows = Tally.add([], rice);
    Tally.add(rows, rice);
    expect(rows[0]?.count).toBe(1);
  });

  it('debounce + tally: a held barcode counts once; re-presenting after 1.2 s counts again', () => {
    TallyController.clear();
    const d = new ScanDebouncer();
    // Camera reports the same code ~every 100 ms while held for 1 s, then again after a 1.3 s gap.
    const times = [0, 100, 200, 500, 1000, 2300, 2400];
    for (const t of times) if (d.accept('074410000123', t)) TallyController.add(rice);
    expect(useTallyStore.getState().rows).toEqual([{ itemId: 'RICE', itemName: rice.name, count: 2 }]);
    TallyController.clear();
  });
});

describe('Beep.wav', () => {
  it('is a valid 16-bit mono PCM WAV', () => {
    const wav = Beep.wav(1000, 50, 8000);
    const v = new DataView(wav.buffer);
    const str = (o: number) => String.fromCharCode(...wav.slice(o, o + 4));
    expect(str(0)).toBe('RIFF');
    expect(str(8)).toBe('WAVE');
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(40, true)).toBe(400 * 2);
    expect(wav.length).toBe(44 + 800);
    expect(v.getInt16(44, true)).toBe(0); // fade-in: no click
  });
});
