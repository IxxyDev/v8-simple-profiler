import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

export function formatCsvReport(results, options = {}) {
  const { includeOptimization = true, includePercentiles = false, delimiter = ',' } = options;

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
    'total_measurements',
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

  return rows
    .map(row => row.map(cell => escapeCsvCell(cell, delimiter)).join(delimiter))
    .join('\n');
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
    result.timing?.count ?? '',
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
