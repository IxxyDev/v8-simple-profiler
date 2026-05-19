import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const DEFAULT_CONFIG = {
  profiling: {
    warmupRuns: 10,
    testRuns: 1000,
    delayBetweenTests: 100, // ms
    runOrderCheck: false,
  },

  output: {
    format: 'console', // 'console' | 'json' | 'csv' | 'all'
    directory: './reports',
    filename: 'profiler-{timestamp}',
    verbose: false,
  },

  analysis: {
    outlierThreshold: 2, // z-score (standard deviations from the mean)
    showInsights: true,
  },

  v8: {
    enableIntrinsics: true,
    forceOptimization: true,
    traceOptimization: true, // forward --trace-opt/--trace-deopt to the child
  },
};

const CONFIG_SCHEMA = {
  profiling: {
    warmupRuns: { type: 'number', min: 1, max: 10000 },
    testRuns: { type: 'number', min: 1, max: 1000000 },
    delayBetweenTests: { type: 'number', min: 0, max: 10000 },
    runOrderCheck: { type: 'boolean' }
  },
  output: {
    format: { type: 'string', enum: ['console', 'json', 'csv', 'all'] },
    directory: { type: 'string' },
    filename: { type: 'string' },
    verbose: { type: 'boolean' }
  },
  analysis: {
    outlierThreshold: { type: 'number', min: 0.1, max: 10 },
    showInsights: { type: 'boolean' }
  },
  v8: {
    enableIntrinsics: { type: 'boolean' },
    forceOptimization: { type: 'boolean' },
    traceOptimization: { type: 'boolean' }
  }
};

export async function loadConfig(configPath) {
  if (!configPath || !existsSync(configPath)) {
    return {};
  }

  try {
    const resolvedPath = resolve(configPath);
    
    if (configPath.endsWith('.json')) {
      const content = await readFile(resolvedPath, 'utf8');
      return JSON.parse(content);
    } else if (configPath.endsWith('.js') || configPath.endsWith('.mjs')) {
      const module = await import(`file://${resolvedPath}`);
      return module.default || module;
    } else {
      throw new Error(`Unsupported config file format: ${configPath}. Use .json, .js, or .mjs`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Configuration file not found: ${configPath}`);
    } else if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in configuration file: ${configPath}\n${error.message}`);
    } else {
      throw new Error(`Failed to load configuration from ${configPath}: ${error.message}`);
    }
  }
}

// Precedence: defaults < userConfig < cliOptions.
export function mergeConfig(defaults = DEFAULT_CONFIG, userConfig = {}, cliOptions = {}) {
  const merged = JSON.parse(JSON.stringify(defaults));
  mergeDeep(merged, userConfig);
  mergeDeep(merged, cliOptions);
  return merged;
}

function mergeDeep(target, source) {
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      mergeDeep(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
}

export function validateConfig(config) {
  const errors = [];
  
  try {
    validateSection(config, CONFIG_SCHEMA, '', errors);
  } catch (error) {
    errors.push(`Configuration validation failed: ${error.message}`);
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    suggestions: generateSuggestions(errors)
  };
}

function validateSection(config, schema, path, errors) {
  for (const key in schema) {
    const currentPath = path ? `${path}.${key}` : key;
    const schemaRule = schema[key];
    const configValue = config[key];

    if (typeof schemaRule === 'object' && !schemaRule.type) {
      if (config[key] && typeof config[key] === 'object') {
        validateSection(config[key], schemaRule, currentPath, errors);
      }
    } else {
      validateProperty(configValue, schemaRule, currentPath, errors);
    }
  }
}

function validateProperty(value, rule, path, errors) {
  // Missing fields are allowed — defaults fill them in.
  if (value === undefined) return;

  if (rule.type && typeof value !== rule.type) {
    errors.push(`${path}: Expected ${rule.type}, got ${typeof value}`);
    return;
  }

  if (rule.enum && !rule.enum.includes(value)) {
    errors.push(`${path}: Must be one of [${rule.enum.join(', ')}], got "${value}"`);
  }

  if (rule.type === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      errors.push(`${path}: Must be at least ${rule.min}, got ${value}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      errors.push(`${path}: Must be at most ${rule.max}, got ${value}`);
    }
  }

  if (rule.type === 'string' && rule.minLength && value.length < rule.minLength) {
    errors.push(`${path}: Must be at least ${rule.minLength} characters long`);
  }
}

function generateSuggestions(errors) {
  const suggestions = [];
  
  for (const error of errors) {
    if (error.includes('output.format')) {
      suggestions.push('Try using one of: "console", "json", "csv", or "all"');
    } else if (error.includes('profiling.')) {
      suggestions.push('Check that profiling numbers are positive and reasonable (e.g., testRuns: 1000)');
    } else if (error.includes('Expected')) {
      suggestions.push('Check the data type of your configuration values');
    }
  }
  
  if (suggestions.length === 0 && errors.length > 0) {
    suggestions.push('Please check the configuration documentation for valid options');
  }
  
  return [...new Set(suggestions)];
}

export async function findAndLoadConfig(customPath) {
  const configPaths = customPath ? [customPath] : [
    './profiler.config.js',
    './profiler.config.mjs',
    './profiler.config.json',
    './config/profiler.config.js',
    './config/profiler.config.mjs',
    './config/profiler.config.json'
  ];
  
  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        return await loadConfig(configPath);
      } catch (error) {
        throw new Error(`Failed to load config from ${configPath}: ${error.message}`);
      }
    }
  }
  
  return {};
}