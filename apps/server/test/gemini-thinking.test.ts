import { describe, expect, it } from 'vitest';
import { thinkingConfig } from '../src/services/scanner.js';
import { DEFAULT_SETTINGS } from '../src/services/settings.js';

describe('Gemini thinking level', () => {
  it('asks Gemini 3 models to think less (faster); leaves older models alone', () => {
    expect(DEFAULT_SETTINGS.geminiThinking).toBe('low');
    expect(thinkingConfig('gemini-3.8-flash', 'low')).toEqual({ thinkingConfig: { thinkingLevel: 'low' } });
    expect(thinkingConfig('gemini-3.5-flash-lite', 'minimal')).toEqual({ thinkingConfig: { thinkingLevel: 'minimal' } });
    expect(thinkingConfig('gemini-2.5-flash', 'low')).toEqual({});
    expect(thinkingConfig('gemini-3.8-flash', undefined)).toEqual({});
  });
});
