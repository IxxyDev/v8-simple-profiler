import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Default configuration with all profiling options
export const DEFAULT_CONFIG = {
  profiling: {
    warmupRuns: 10,           // Number of warmup iterations
    testRuns: 1000,           // Number of measurement iterations
    iterations: 1,            // Number of complete test cycles
    delayBetweenTests: 100    // Milliseconds between tests
  },
  
  output: {
    format: 'console',        // 'console', 'json', 'csv', 'all'
    directory: './reports',   // Output directory for file exports
    filename: 'profiler-{timestamp}', // Filename template
    verbose: false            // Include detailed output
  },
  
  analysis: {
    outlierThreshold: 2,      // Standard deviations for outlier detection
    confidenceLevel: 0.95,    // Statistical confidence level
    showInsights: true        // Include performance insights
  },
  
  v8: {
    enableIntrinsics: true,   // Attempt to use V8 intrinsics
    forceOptimization: true,  // Force function optimization
    monitorStderr: true       // Monitor stderr for V8 events
  }
};

/**
 * Configuration validation schema
 */
const CONFIG_SCHEMA = {
  profiling: {
    warmupRuns: { type: 'number', min: 1, max: 10000 },
    testRuns: { type: 'number', min: 1, max: 1000000 },
    iterations: { type: 'number', min: 1, max: 100 },
    delayBetweenTests: { type: 'number', min: 0, max: 10000 }
  },
  output: {
    format: { type: 'string', enum: ['console', 'json', 'csv', 'all'] },
    directory: { type: 'string' },
    filename: { type: 'string' },
    verbose: { type: 'boolean' }
  },
  analysis: {
    outlierThreshold: { type: 'number', min: 0.1, max: 10 },
    confidenceLevel: { type: 'number', min: 0.5, max: 0.99 },
    showInsights: { type: 'boolean' }
  },
  v8: {
    enableIntrinsics: { type: 'boolean' },
    forceOptimization: { type: 'boolean' },
    monitorStderr: { type: 'boolean' }
  }
};

/**
 * Load configuration from a file path
 * Supports both JSON and JS module formats
 * @param {string} configPath - Path to configuration file
 * @returns {Promise<Object>} Parsed configuration object
 */
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

/**
 * Merge configuration from multiple sources with proper precedence
 * CLI options > user config > defaults
 * @param {Object} defaults - Default configuration
 * @param {Object} userConfig - User configuration from file
 * @param {Object} cliOptions - CLI options
 * @returns {Object} Merged configuration
 */
export function mergeConfig(defaults = DEFAULT_CONFIG, userConfig = {}, cliOptions = {}) {
  const merged = JSON.parse(JSON.stringify(defaults)); // Deep clone defaults
  
  // Merge user config
  mergeDeep(merged, userConfig);
  
  // Merge CLI options (highest precedence)
  mergeDeep(merged, cliOptions);
  
  return merged;
}

/**
 * Deep merge two objects
 * @param {Object} target - Target object to merge into
 * @param {Object} source - Source object to merge from
 */
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

/**
 * Validate configuration against schema with helpful error messages
 * @param {Object} config - Configuration to validate
 * @returns {Object} Validation result with isValid and errors
 */
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

/**
 * Validate a configuration section recursively
 * @param {Object} config - Configuration section to validate
 * @param {Object} schema - Schema section to validate against
 * @param {string} path - Current path for error reporting
 * @param {Array} errors - Array to collect errors
 */
function validateSection(config, schema, path, errors) {
  for (const key in schema) {
    const currentPath = path ? `${path}.${key}` : key;
    const schemaRule = schema[key];
    const configValue = config[key];
    
    if (typeof schemaRule === 'object' && !schemaRule.type) {
      // Nested object
      if (config[key] && typeof config[key] === 'object') {
        validateSection(config[key], schemaRule, currentPath, errors);
      }
    } else {
      // Validate individual property
      validateProperty(configValue, schemaRule, currentPath, errors);
    }
  }
}

/**
 * Validate individual property against schema rule
 * @param {*} value - Value to validate
 * @param {Object} rule - Schema rule
 * @param {string} path - Property path for error reporting
 * @param {Array} errors - Array to collect errors
 */
function validateProperty(value, rule, path, errors) {
  if (value === undefined) return; // Optional properties
  
  // Type validation
  if (rule.type && typeof value !== rule.type) {
    errors.push(`${path}: Expected ${rule.type}, got ${typeof value}`);
    return;
  }
  
  // Enum validation
  if (rule.enum && !rule.enum.includes(value)) {
    errors.push(`${path}: Must be one of [${rule.enum.join(', ')}], got "${value}"`);
  }
  
  // Number range validation
  if (rule.type === 'number') {
    if (rule.min !== undefined && value < rule.min) {
      errors.push(`${path}: Must be at least ${rule.min}, got ${value}`);
    }
    if (rule.max !== undefined && value > rule.max) {
      errors.push(`${path}: Must be at most ${rule.max}, got ${value}`);
    }
  }
  
  // String validation
  if (rule.type === 'string' && rule.minLength && value.length < rule.minLength) {
    errors.push(`${path}: Must be at least ${rule.minLength} characters long`);
  }
}

/**
 * Generate helpful suggestions based on validation errors
 * @param {Array} errors - Validation errors
 * @returns {Array} Array of suggestions
 */
function generateSuggestions(errors) {
  const suggestions = [];
  
  for (const error of errors) {
    if (error.includes('output.format')) {
      suggestions.push('Try using one of: "console", "json", "csv", or "all"');
    } else if (error.includes('profiling.')) {
      suggestions.push('Check that profiling numbers are positive and reasonable (e.g., testRuns: 1000)');
    } else if (error.includes('analysis.confidenceLevel')) {
      suggestions.push('Confidence level should be between 0.5 and 0.99 (e.g., 0.95 for 95% confidence)');
    } else if (error.includes('Expected')) {
      suggestions.push('Check the data type of your configuration values');
    }
  }
  
  if (suggestions.length === 0 && errors.length > 0) {
    suggestions.push('Please check the configuration documentation for valid options');
  }
  
  return [...new Set(suggestions)]; // Remove duplicates
}

/**
 * Find and load configuration file from common locations
 * @param {string} customPath - Custom config path from CLI
 * @returns {Promise<Object>} Configuration object
 */
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
  
  return {}; // No config file found, use defaults
}