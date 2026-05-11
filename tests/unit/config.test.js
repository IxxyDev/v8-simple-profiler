import { describe, it, expect, beforeEach } from 'vitest';
import { 
  DEFAULT_CONFIG, 
  loadConfig, 
  mergeConfig, 
  validateConfig,
  findAndLoadConfig 
} from '../../src/utils/config.js';
import { writeFile, unlink, mkdir, mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('Configuration System', () => {
  const testConfigPath = './test-config.json';
  const testConfigJsPath = './test-config.js';
  
  beforeEach(async () => {
    try {
      if (existsSync(testConfigPath)) await unlink(testConfigPath);
      if (existsSync(testConfigJsPath)) await unlink(testConfigJsPath);
    } catch {
      // best-effort cleanup
    }
  });

  describe('DEFAULT_CONFIG', () => {
    it('should have all required sections', () => {
      expect(DEFAULT_CONFIG).toHaveProperty('profiling');
      expect(DEFAULT_CONFIG).toHaveProperty('output');
      expect(DEFAULT_CONFIG).toHaveProperty('analysis');
      expect(DEFAULT_CONFIG).toHaveProperty('v8');
    });

    it('should have sensible default values', () => {
      expect(DEFAULT_CONFIG.profiling.warmupRuns).toBe(10);
      expect(DEFAULT_CONFIG.profiling.testRuns).toBe(1000);
      expect(DEFAULT_CONFIG.output.format).toBe('console');
      expect(DEFAULT_CONFIG.analysis.confidenceLevel).toBe(0.95);
      expect(DEFAULT_CONFIG.v8.enableIntrinsics).toBe(true);
    });
  });

  describe('loadConfig', () => {
    it('should return empty object for non-existent file', async () => {
      const config = await loadConfig('./non-existent.json');
      expect(config).toEqual({});
    });

    it('should load JSON configuration', async () => {
      const testConfig = {
        profiling: { warmupRuns: 20 },
        output: { format: 'json' }
      };
      
      await writeFile(testConfigPath, JSON.stringify(testConfig));
      const config = await loadConfig(testConfigPath);
      
      expect(config.profiling.warmupRuns).toBe(20);
      expect(config.output.format).toBe('json');
    });

    it('should load JavaScript module configuration', async () => {
      const jsConfig = `export default {
        profiling: { warmupRuns: 30 },
        output: { format: 'csv' }
      };`;
      
      await writeFile(testConfigJsPath, jsConfig);
      const config = await loadConfig(testConfigJsPath);
      
      expect(config.profiling.warmupRuns).toBe(30);
      expect(config.output.format).toBe('csv');
    });

    it('should throw error for invalid JSON', async () => {
      await writeFile(testConfigPath, '{ invalid json }');
      
      await expect(loadConfig(testConfigPath)).rejects.toThrow('Invalid JSON');
    });

    it('should throw error for unsupported file format', async () => {
      const txtPath = './test.txt';
      await writeFile(txtPath, 'dummy');
      try {
        await expect(loadConfig(txtPath)).rejects.toThrow('Unsupported config file format');
      } finally {
        if (existsSync(txtPath)) await unlink(txtPath);
      }
    });
  });

  describe('mergeConfig', () => {
    it('should merge configurations with proper precedence', () => {
      const userConfig = {
        profiling: { warmupRuns: 20 },
        output: { format: 'json' }
      };
      
      const cliOptions = {
        profiling: { testRuns: 500 },
        output: { verbose: true }
      };
      
      const merged = mergeConfig(DEFAULT_CONFIG, userConfig, cliOptions);
      
      expect(merged.profiling.warmupRuns).toBe(20); // from userConfig
      expect(merged.profiling.testRuns).toBe(500); // from cliOptions
      expect(merged.profiling.iterations).toBe(1); // from defaults
      expect(merged.output.format).toBe('json'); // from userConfig
      expect(merged.output.verbose).toBe(true); // from cliOptions
    });

    it('should handle nested object merging', () => {
      const userConfig = {
        profiling: { warmupRuns: 15 }
      };
      
      const merged = mergeConfig(DEFAULT_CONFIG, userConfig);
      
      expect(merged.profiling.warmupRuns).toBe(15);
      expect(merged.profiling.testRuns).toBe(1000); // preserved from defaults
      expect(merged.output).toEqual(DEFAULT_CONFIG.output); // unchanged
    });
  });

  describe('validateConfig', () => {
    it('should validate correct configuration', () => {
      const result = validateConfig(DEFAULT_CONFIG);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect type errors', () => {
      const invalidConfig = {
        profiling: { warmupRuns: 'not-a-number' },
        output: { verbose: 'not-a-boolean' }
      };
      
      const result = validateConfig(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors.some(e => e.includes('warmupRuns'))).toBe(true);
      expect(result.errors.some(e => e.includes('verbose'))).toBe(true);
    });

    it('should detect range errors', () => {
      const invalidConfig = {
        profiling: { warmupRuns: -1, testRuns: 2000000 },
        analysis: { confidenceLevel: 1.5 }
      };
      
      const result = validateConfig(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('at least'))).toBe(true);
      expect(result.errors.some(e => e.includes('at most'))).toBe(true);
    });

    it('should detect enum errors', () => {
      const invalidConfig = {
        output: { format: 'invalid-format' }
      };
      
      const result = validateConfig(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('Must be one of'))).toBe(true);
    });

    it('should provide helpful suggestions', () => {
      const invalidConfig = {
        output: { format: 'invalid-format' },
        profiling: { warmupRuns: -1 }
      };
      
      const result = validateConfig(invalidConfig);
      expect(result.suggestions.length).toBeGreaterThan(0);
      expect(result.suggestions.some(s => s.includes('console'))).toBe(true);
    });
  });

  describe('findAndLoadConfig', () => {
    it('should return empty object when no config files exist', async () => {
      const isolated = await mkdtemp(join(tmpdir(), 'v8-profiler-cfg-'));
      const originalCwd = process.cwd();
      try {
        process.chdir(isolated);
        const config = await findAndLoadConfig();
        expect(config).toEqual({});
      } finally {
        process.chdir(originalCwd);
        await rm(isolated, { recursive: true, force: true });
      }
    });

    it('should load custom config path when provided', async () => {
      const testConfig = { profiling: { warmupRuns: 25 } };
      await writeFile(testConfigPath, JSON.stringify(testConfig));
      
      const config = await findAndLoadConfig(testConfigPath);
      expect(config.profiling.warmupRuns).toBe(25);
    });
  });
});