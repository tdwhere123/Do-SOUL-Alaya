/**
 * Isotonic (PAVA) calibration helpers for abstention evaluation.
 * Kept separate so the main calibration lib stays under the 500-line file budget.
 * summarizeIsotonic takes summarize helpers from the lib to avoid a circular import.
 */

function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Pool Adjacent Violators Algorithm (PAVA) for non-decreasing isotonic
 * regression of binary labels onto a sorted score axis.
 * Fit only on the training split (answerable + synthetic negatives).
 */
function fitIsotonicPava(examples, signal) {
  const points = examples
    .map((example) => ({
      x: numberOrNull(example.features[signal]),
      y: example.should_answer ? 1 : 0
    }))
    .filter((point) => point.x !== null)
    .sort((left, right) => left.x - right.x || left.y - right.y);
  if (points.length === 0) {
    return { signal, blocks: [], fitted_count: 0 };
  }
  const blocks = points.map((point) => ({
    xMin: point.x,
    xMax: point.x,
    sum: point.y,
    weight: 1,
    mean: point.y
  }));
  let index = 0;
  while (index < blocks.length - 1) {
    if (blocks[index].mean <= blocks[index + 1].mean) {
      index += 1;
      continue;
    }
    const merged = {
      xMin: blocks[index].xMin,
      xMax: blocks[index + 1].xMax,
      sum: blocks[index].sum + blocks[index + 1].sum,
      weight: blocks[index].weight + blocks[index + 1].weight,
      mean: 0
    };
    merged.mean = merged.sum / merged.weight;
    blocks.splice(index, 2, merged);
    if (index > 0) index -= 1;
  }
  return {
    signal,
    fitted_count: points.length,
    blocks: blocks.map((block) => ({
      x_min: block.xMin,
      x_max: block.xMax,
      calibrated: block.mean,
      weight: block.weight
    }))
  };
}

function applyIsotonic(fit, rawValue) {
  if (rawValue === null || fit.blocks.length === 0) return null;
  if (rawValue <= fit.blocks[0].x_min) return fit.blocks[0].calibrated;
  for (const block of fit.blocks) {
    if (rawValue >= block.x_min && rawValue <= block.x_max) {
      return block.calibrated;
    }
  }
  return fit.blocks[fit.blocks.length - 1].calibrated;
}

function withCalibratedFeature(examples, signal, fit, calibratedKey) {
  return examples.map((example) => {
    const raw = numberOrNull(example.features[signal]);
    return {
      ...example,
      features: {
        ...example.features,
        [calibratedKey]: applyIsotonic(fit, raw)
      }
    };
  });
}

export function calibratedSignalName(signal) {
  return `isotonic_${signal}`;
}

export function summarizeIsotonic(examples, helpers) {
  const { sourceSignals, summarizeSignal, summarizeRocAuc } = helpers;
  const fits = {};
  const roc = [];
  const signals = [];
  for (const signal of sourceSignals) {
    const fit = fitIsotonicPava(examples.training, signal);
    fits[signal] = fit;
    const calibratedKey = calibratedSignalName(signal);
    const answerable = withCalibratedFeature(examples.answerable, signal, fit, calibratedKey);
    const holdout = withCalibratedFeature(examples.holdoutAbstentions, signal, fit, calibratedKey);
    const training = withCalibratedFeature(examples.training, signal, fit, calibratedKey);
    signals.push(
      summarizeSignal(training, holdout, calibratedKey, { includeSweep: false })
    );
    roc.push({
      signal: calibratedKey,
      source_signal: signal,
      family: "isotonic_calibrated",
      comparison_group: "isotonic",
      ...summarizeRocAuc(answerable, holdout, calibratedKey)
    });
  }
  return { fits, signals, roc };
}
