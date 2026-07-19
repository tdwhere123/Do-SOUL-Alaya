export function renderSeparabilityTrackReport(input) {
  const { evidenceMode, foldModels, rows, track } = input;
  const measurementRows = rows.filter((row) => row.measurement_scorable === true);
  const measuredHits = measurementRows.filter((row) => row.any_at_5 === true).length;
  const currentHits = measurementRows.filter((row) => row.current_any_at_5).length;
  const currentPairwiseHits = rows.filter((row) =>
    row.status === "scored" && row.measurement_scorable === true && row.current_any_at_5
  ).length;
  const scoredHits = rows.filter((row) => row.any_at_5 === true).length;
  const publishesMeasurement = evidenceMode !== "legacy_pairwise_diagnostic";
  const measuredRate = publishesMeasurement
    ? ratio(measuredHits, measurementRows.length)
    : null;
  return Object.freeze({
    track,
    rows: Object.freeze(rows),
    fold_models: Object.freeze(foldModels),
    any_at_5_count: scoredHits,
    runtime_scorable_any_at_5: measuredRate,
    end_to_end_projection_any_at_5: measuredRate,
    current_any_at_5_count: publishesMeasurement ? currentHits : null,
    current_end_to_end_any_at_5: publishesMeasurement
      ? ratio(currentHits, measurementRows.length)
      : null,
    gain_count: rows.filter((row) => row.any_at_5 === true && !row.current_any_at_5).length,
    loss_count: rows.filter((row) => row.any_at_5 === false && row.current_any_at_5).length,
    retrieval_conditional_net_gain_count: publishesMeasurement
      ? scoredHits - currentPairwiseHits
      : null,
    question_type_metrics: summarizeQuestionTypes(rows, publishesMeasurement)
  });
}

export function compareSeparabilityTracks(baseline, typedPath) {
  const baselineById = new Map(baseline.rows.map((row) => [row.question_id, row]));
  const uniqueGains = typedPath.rows.filter((row) =>
    row.any_at_5 === true && baselineById.get(row.question_id)?.any_at_5 === false
  );
  const uniqueLosses = typedPath.rows.filter((row) =>
    row.any_at_5 === false && baselineById.get(row.question_id)?.any_at_5 === true
  );
  return Object.freeze({
    baseline_gain_count: baseline.gain_count,
    baseline_loss_count: baseline.loss_count,
    typed_path_unique_gain_count: uniqueGains.length,
    typed_path_unique_loss_count: uniqueLosses.length,
    typed_path_unique_gain_question_ids: Object.freeze(uniqueGains.map((row) => row.question_id)),
    typed_path_unique_loss_question_ids: Object.freeze(uniqueLosses.map((row) => row.question_id))
  });
}

function summarizeQuestionTypes(rows, publishesMeasurement) {
  const types = [...new Set(rows.map((row) => row.question_type ?? "unknown"))].sort();
  return Object.freeze(types.map((type) => {
    const members = rows.filter((row) => (row.question_type ?? "unknown") === type);
    const scored = members.filter((row) => row.status === "scored");
    const measurementScorable = publishesMeasurement
      ? members.filter((row) => row.measurement_scorable === true)
      : [];
    return Object.freeze({
      question_type: type,
      dataset_answerable_count: members.length,
      runtime_scorable_count: measurementScorable.length,
      pairwise_eligible_count: scored.length,
      any_at_5_count: scored.filter((row) => row.any_at_5 === true).length,
      gain_count: scored.filter((row) => row.any_at_5 === true && !row.current_any_at_5).length,
      loss_count: scored.filter((row) => row.any_at_5 === false && row.current_any_at_5).length
    });
  }));
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}
