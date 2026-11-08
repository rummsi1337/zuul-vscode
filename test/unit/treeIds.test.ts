import { describe, expect, it } from 'vitest';
import { uniqueIds } from '../../src/util/treeIds';

describe('uniqueIds', () => {
  it('keeps ids without repeats', () => {
    expect(uniqueIds(['a', 'b'])).toEqual(['a', 'b']);
  });

  it('suffixes repeats and leaves the first use unchanged', () => {
    expect(uniqueIds(['a', 'a', 'a'])).toEqual(['a', 'a~2', 'a~3']);
  });

  it('skips a generated value that is already taken', () => {
    expect(uniqueIds(['a', 'a', 'a~2'])).toEqual(['a', 'a~3', 'a~2']);
  });
});
