#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'node:path';

import { createProfiler } from '../core/profiler.js';
import { findAndLoadConfig, mergeConfig, validateConfig, DEFAULT_CONFIG } from '../utils/config.js';
import { formatConsoleReport } from '../reporters/console.js';
import { saveJsonReport, generateFilename } from '../reporters/json.js';
import { saveCsvReport } from '../reporters/csv.js';
import { loadBenchmarks, collectBenchmarkSpecs } from './load-benchmarks.js';

const program = new Command();

program
  .name('v8-profiler')
  .description('V8 deoptimization profiler with comprehensive analysis and reporting')
  .version('1.0.0')
  .option('-c, --config <path>', 'path to configuration file')
  .option(
    '-b, --benchmarks <spec>',
    'benchmark file(s) to profile; comma-separate or repeat the flag. Use path#functionName to pick one export',
    collectBenchmarkSpecs,
    []
  )
  .option('-f, --format <type>', 'output format (console, json, csv, all)', 'console')
  .option('-o, --output <directory>', 'output directory for reports', './reports')
  .option('-w, --warmup <runs>', 'number of warmup runs', parseInt)
  .option('-r, --runs <count>', 'number of test runs', parseInt)
  .option('-d, --delay <ms>', 'delay between tests in milliseconds', parseInt)
  .option('-v, --verbose', 'verbose output')
  .option('--no-v8', 'disable V8 intrinsics')
  .option('--no-optimization', 'disable forced optimization')
  .option('--threshold <value>', 'outlier detection threshold', parseFloat)
  .option('--filename <template>', 'filename template for reports')
  .option(
    '--run-order-check',
    'rerun benchmarks in reverse order and warn if the ranking flips (doubles wall-clock time)'
  )
  .addHelpText(
    'after',
    `
Examples:
  $ v8-profiler                          # Run with default settings
  $ v8-profiler --config ./my-config.js  # Use custom config
  $ v8-profiler --format json -o ./out   # Export to JSON
  $ v8-profiler --runs 5000 --verbose    # More runs with verbose output
  $ v8-profiler --format all             # Export to all formats
  $ v8-profiler -b ./bench.js            # Profile every export of bench.js
  $ v8-profiler -b ./bench.js#hotPath    # Profile only the hotPath export
  $ v8-profiler -b a.js -b b.js#fn       # Multiple benchmark files

Config file examples:
  ./profiler.config.js
  ./config/profiler.config.json

For more information, visit: https://github.com/IxxyDev/v8-simple-profiler
`
  );

program.action(async options => {
  try {
    console.log(chalk.cyan('=== V8 DEOPTIMIZATION PROFILER ===\n'));

    const config = await loadConfiguration(options);

    if (!config.isValid) {
      console.error(chalk.red('Configuration validation failed:'));
      config.errors.forEach(error => console.error(chalk.red(`  • ${error}`)));

      if (config.suggestions.length > 0) {
        console.log(chalk.yellow('\nSuggestions:'));
        config.suggestions.forEach(suggestion => console.log(chalk.yellow(`  • ${suggestion}`)));
      }

      process.exit(1);
    }

    const profiler = await createProfiler(config.data);

    const benchmarks = await loadBenchmarks(options.benchmarks);

    if (benchmarks.length === 0) {
      console.error(chalk.red('No benchmarks found. Please add benchmark functions.'));
      process.exit(1);
    }

    console.log(chalk.green(`Found ${benchmarks.length} benchmark(s) to profile`));

    if (!config.data.v8.enableIntrinsics) {
      console.log(
        chalk.yellow(
          'V8 intrinsics disabled in config — tier flags and trace counters will not appear.'
        )
      );
    }

    const results = await profiler.runBenchmarks(benchmarks);

    await generateReports(results, config.data);
  } catch (error) {
    console.error(chalk.red('Error:'), error.message);

    if (options.verbose) {
      console.error(chalk.gray(error.stack));
    }

    process.exit(1);
  }
});

async function loadConfiguration(options) {
  try {
    const userConfig = await findAndLoadConfig(options.config);

    const cliConfig = buildCliConfig(options);

    const mergedConfig = mergeConfig(DEFAULT_CONFIG, userConfig, cliConfig);

    const validation = validateConfig(mergedConfig);

    return {
      isValid: validation.isValid,
      errors: validation.errors,
      suggestions: validation.suggestions,
      data: mergedConfig,
    };
  } catch (error) {
    return {
      isValid: false,
      errors: [error.message],
      suggestions: ['Check your configuration file path and syntax'],
      data: null,
    };
  }
}

function buildCliConfig(options) {
  const cliConfig = {};

  if (options.warmup !== undefined) {
    cliConfig.profiling = { warmupRuns: options.warmup };
  }

  if (options.runs !== undefined) {
    cliConfig.profiling = { ...cliConfig.profiling, testRuns: options.runs };
  }

  if (options.delay !== undefined) {
    cliConfig.profiling = { ...cliConfig.profiling, delayBetweenTests: options.delay };
  }

  if (options.format) {
    cliConfig.output = { format: options.format };
  }

  if (options.output) {
    cliConfig.output = { ...cliConfig.output, directory: options.output };
  }

  if (options.filename) {
    cliConfig.output = { ...cliConfig.output, filename: options.filename };
  }

  if (options.verbose) {
    cliConfig.output = { ...cliConfig.output, verbose: true };
  }

  if (options.v8 === false) {
    cliConfig.v8 = { enableIntrinsics: false };
  }

  if (options.optimization === false) {
    cliConfig.v8 = { ...cliConfig.v8, forceOptimization: false };
  }

  if (options.threshold !== undefined) {
    cliConfig.analysis = { outlierThreshold: options.threshold };
  }

  if (options.runOrderCheck) {
    cliConfig.profiling = { ...cliConfig.profiling, runOrderCheck: true };
  }

  return cliConfig;
}

async function generateReports(results, config) {
  const format = config.output.format;
  const outputDir = config.output.directory;
  const filenameTemplate = config.output.filename;

  if (format === 'console' || format === 'all') {
    formatConsoleReport(results, {
      verbose: config.output.verbose,
      showInsights: config.analysis.showInsights,
    });
  }

  if (format === 'json' || format === 'all') {
    const filename = generateFilename(filenameTemplate, 'json');
    const filepath = resolve(outputDir, filename);

    await saveJsonReport(results, filepath, {
      pretty: true,
      includeMetadata: true,
    });

    console.log(chalk.green(`✓ JSON report saved to ${filepath}`));
  }

  if (format === 'csv' || format === 'all') {
    const filename = generateFilename(filenameTemplate, 'csv');
    const filepath = resolve(outputDir, filename);

    await saveCsvReport(results, filepath, {
      includeOptimization: true,
      includePercentiles: config.output.verbose,
    });

    console.log(chalk.green(`✓ CSV report saved to ${filepath}`));
  }
}

program.parse();
