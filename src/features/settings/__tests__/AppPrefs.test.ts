import { Appearance } from 'react-native';

import { WasmSqlDb } from '../../../db/testing/wasmDb';
import { AppPrefs } from '../AppPrefs';

describe('AppPrefs', () => {
  it.each([
    ['5', 5], ['0', 0], [' 12 ', 12], ['', null], ['-1', null], ['1.5', null], ['10000', null], ['abc', null],
  ])('threshold %p → %p', (t, v) => expect(AppPrefs.parseThreshold(t)).toBe(v));

  it.each([
    ['2', '2'], ['2, 02', '2, 02'], ['2 02', '2, 02'], ['', null], ['2, x', null], ['1234', null],
  ])('prefixes %p → %p', (t, v) => expect(AppPrefs.parsePrefixes(t)).toBe(v));

  it('theme defaults to system, persists, and overrides the RN appearance', async () => {
    const db = await WasmSqlDb.migrated();
    const spy = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => undefined);
    expect(await AppPrefs.theme(db)).toBe('system');
    await AppPrefs.setTheme(db, 'dark');
    expect(await AppPrefs.theme(db)).toBe('dark');
    expect(spy).toHaveBeenLastCalledWith('dark');
    AppPrefs.applyTheme('system');
    expect(spy).toHaveBeenLastCalledWith('unspecified');
    spy.mockRestore();
    db.close();
  });

  it('version/build come from the app config', () => {
    const v = AppPrefs.version();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v.build).toBeTruthy();
  });
});
