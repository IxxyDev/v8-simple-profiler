import { writeFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';

export function formatCsvReport(results, options = {}) {
  const {
    includeOptimization = true,
    includePercentiles = false,
    delimiter = ','
  } = options;

  const headers = [
    'name',
    'status',
    'mean_ms',
    'median_ms',
    'min_ms',
    'max_ms',
    'std_dev_ms',
    'reliability',
    'outliers',
    'total_measurements'
  ];

  if (includePercentiles) {
    headers.push('p25_ms', 'p75_ms', 'p90_ms', 'p95_ms', 'p99_ms');
  }

  if (includeOptimization) {
    headers.push('v8_available', 'optimized', 'deoptimized', 'optimization_attempts');
  }

  headers.push('timestamp');

  const rows = [headers];

  for (const result of results) {
    const row = formatResultRow(result, { includeOptimization, includePercentiles });
    rows.push(row);
  }

  return rows.map(row => row.map(cell => escapeCsvCell(cell, delimiter)).join(delimiter)).join('\n');
}

function formatResultRow(result, options) {
  const { includeOptimization, includePercentiles } = options;

  const baseRow = [
    result.name,
    result.error ? 'error' : 'success',
    result.timing?.mean ?? '',
    result.timing?.median ?? '',
    result.timing?.min ?? '',
    result.timing?.max ?? '',
    result.timing?.stdDev ?? '',
    result.timing?.reliability ?? '',
    result.timing?.outliers ?? '',
    result.timing?.count ?? ''
  ];

  if (includePercentiles) {
    baseRow.push(
      result.timing?.p25 ?? '',
      result.timing?.p75 ?? '',
      result.timing?.p90 ?? '',
      result.timing?.p95 ?? '',
      result.timing?.p99 ?? ''
    );
  }

  if (includeOptimization) {
    baseRow.push(
      result.optimization?.available ? 'yes' : 'no',
      result.optimization?.flags?.optimized ? 'yes' : 'no',
      result.optimization?.deoptimized ? 'yes' : 'no',
      result.optimization?.attempts ?? ''
    );
  }

  baseRow.push(result.metadata?.timestamp ?? '');

  return baseRow;
}

function escapeCsvCell(cell, delimiter) {
  const stringValue = String(cell);

  if (stringValue.includes(delimiter) || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

export async function saveCsvReport(results, filepath, options = {}) {
  try {
    const resolvedPath = resolve(filepath);
    const dir = dirname(resolvedPath);

    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }

    const csvContent = formatCsvReport(results, options);
    await writeFile(resolvedPath, csvContent, 'utf8');

    console.log(`CSV report saved to: ${resolvedPath}`);
    return resolvedPath;
  } catch (error) {
    console.error('Failed to save CSV report:', error.message);
    throw error;
  }
}

export function formatCsvSummary(results, options = {}) {
  const { delimiter = ',' } = options;

  const validResults = results.filter(r => !r.error && r.timing);

  if (validResults.length === 0) {
    return 'No valid results to summarize';
  }

  const fastest = validResults.reduce((min, current) =>
    current.timing.mean < min.timing.mean ? current : min
  );

  const slowest = validResults.reduce((max, current) =>
    current.timing.mean > max.timing.mean ? current : max
  );

  const totalMeasurements = validResults.reduce((sum, r) => sum + r.timing.count, 0);
  const avgExecutionTime = validResults.reduce((sum, r) => sum + r.timing.mean, 0) / validResults.length;

  const optimizedCount = validResults.filter(r =>
    r.optimization.available && r.optimization.flags?.optimized
  ).length;

  const summaryRows = [
    ['metric', 'value'],
    ['total_functions', results.length],
    ['successful_functions', validResults.length],
    ['failed_functions', results.length - validResults.length],
    ['total_measurements', totalMeasurements],
    ['fastest_function', fastest.name],
    ['fastest_time_ms', fastest.timing.mean],
    ['slowest_function', slowest.name],
    ['slowest_time_ms', slowest.timing.mean],
    ['speedup_ratio', (slowest.timing.mean / fastest.timing.mean).toFixed(2)],
    ['average_execution_time_ms', avgExecutionTime.toFixed(4)],
    ['optimized_functions', optimizedCount],
    ['optimization_rate_percent', ((optimizedCount / validResults.length) * 100).toFixed(2)]
  ];

  return summaryRows.map(row => row.map(cell => escapeCsvCell(cell, delimiter)).join(delimiter)).join('\n');
}

export function formatCsvComparison(results, options = {}) {
  const { delimiter = ',' } = options;

  const validResults = results.filter(r => !r.error && r.timing);

  if (validResults.length < 2) {
    return 'Insufficient data for comparison';
  }

  const comparisonRows = [
    ['function_a', 'function_b', 'a_mean_ms', 'b_mean_ms', 'speedup_ratio', 'percentage_difference']
  ];

  for (let i = 0; i < validResults.length; i++) {
    for (let j = i + 1; j < validResults.length; j++) {
      const a = validResults[i];
      const b = validResults[j];

      const speedup = b.timing.mean / a.timing.mean;
      const percentageDiff = ((b.timing.mean - a.timing.mean) / a.timing.mean) * 100;

      comparisonRows.push([
        a.name,
        b.name,
        a.timing.mean,
        b.timing.mean,
        speedup.toFixed(2),
        percentageDiff.toFixed(2)
      ]);
    }
  }

  return comparisonRows.map(row => row.map(cell => escapeCsvCell(cell, delimiter)).join(delimiter)).join('\n');
}

export function parseCsvReport(csvContent, options = {}) {
  const { delimiter = ',' } = options;

  const lines = csvContent.split('\n').filter(line => line.trim());

  if (lines.length < 2) {
    throw new Error('Invalid CSV format: insufficient data');
  }

  const headers = parseCsvLine(lines[0], delimiter);
  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i], delimiter);

    if (values.length !== headers.length) {
      console.warn(`Line ${i + 1}: column count mismatch, skipping`);
      continue;
    }

    const result = {};

    for (let j = 0; j < headers.length; j++) {
      result[headers[j]] = values[j];
    }

    results.push(result);
  }

  return results;
}

function parseCsvLine(line, delimiter) {
  const values = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === '"' && !inQuotes) {
      inQuotes = true;
    } else if (char === '"' && inQuotes) {
      if (i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = false;
      }
    } else if (char === delimiter && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }

    i++;
  }

  values.push(current);
  return values;
}