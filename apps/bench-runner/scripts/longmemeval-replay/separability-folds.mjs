export function assignGroupedStratifiedFolds(questions, requestedFoldCount = 5) {
  const rows = requireQuestions(questions);
  const groups = buildLeakageGroups(rows);
  if (groups.length < 3) {
    throw new Error(`separability requires at least 3 leakage groups; found ${groups.length}`);
  }
  const foldCount = Math.min(normalizeFoldCount(requestedFoldCount), groups.length);
  const folds = Array.from({ length: foldCount }, (_, index) => ({
    index, size: 0, strata: new Map(), groups: []
  }));
  for (const group of orderGroups(groups)) {
    const target = [...folds].sort((left, right) => compareFoldFit(left, right, group))[0];
    addGroup(target, group);
  }
  const assignments = new Map();
  for (const fold of folds) {
    for (const group of fold.groups) {
      for (const question of group.questions) assignments.set(question.question_id, fold.index);
    }
  }
  return assignments;
}

export function buildLeakageGroups(questions) {
  const rows = requireQuestions(questions);
  const parents = rows.map((_, index) => index);
  const ownerByKey = new Map();
  rows.forEach((question, index) => {
    for (const key of leakageKeys(question)) {
      const owner = ownerByKey.get(key);
      if (owner === undefined) ownerByKey.set(key, index);
      else union(parents, owner, index);
    }
  });
  const grouped = new Map();
  rows.forEach((question, index) => {
    const root = find(parents, index);
    const members = grouped.get(root) ?? [];
    members.push(question);
    grouped.set(root, members);
  });
  return [...grouped.values()].map(renderGroup).sort((left, right) => left.key.localeCompare(right.key));
}

function renderGroup(questions) {
  const ordered = [...questions].sort((left, right) => left.question_id.localeCompare(right.question_id));
  const strata = new Map();
  for (const question of ordered) {
    const key = stratum(question);
    strata.set(key, (strata.get(key) ?? 0) + 1);
  }
  return Object.freeze({ key: ordered[0].question_id, questions: Object.freeze(ordered), strata });
}

function compareFoldFit(left, right, group) {
  const leftStratum = stratumCost(left, group);
  const rightStratum = stratumCost(right, group);
  if (leftStratum !== rightStratum) return leftStratum - rightStratum;
  if (left.size !== right.size) return left.size - right.size;
  return left.index - right.index;
}

function stratumCost(fold, group) {
  let cost = 0;
  for (const [key, count] of group.strata) cost += (fold.strata.get(key) ?? 0) * count;
  return cost;
}

function addGroup(fold, group) {
  fold.groups.push(group);
  fold.size += group.questions.length;
  for (const [key, count] of group.strata) fold.strata.set(key, (fold.strata.get(key) ?? 0) + count);
}

function orderGroups(groups) {
  return [...groups].sort((left, right) =>
    right.questions.length - left.questions.length || left.key.localeCompare(right.key)
  );
}

function leakageKeys(question) {
  const sessions = stringArray(question.answer_session_ids).map((value) => `session:${value}`);
  const gold = goldObjectIds(question).map((value) => `gold:${value}`);
  return [...new Set([...sessions, ...gold])].sort();
}

function goldObjectIds(question) {
  const rows = Array.isArray(question.gold) ? question.gold : [];
  const runtimeGold = rows.flatMap((row) =>
    row !== null && typeof row === "object" && typeof row.object_id === "string"
      ? [row.object_id]
      : []
  );
  const evaluator = question.cohort_ledger?.evaluator_gold_identity?.object_ids;
  return [...new Set([...runtimeGold, ...stringArray(evaluator)])];
}

function stratum(question) {
  const type = typeof question.question_type === "string" ? question.question_type : "unknown";
  return `${type}|${question.candidate_pool_complete === true ? "scorable" : "unscorable"}`;
}

function requireQuestions(value) {
  if (!Array.isArray(value)) throw new Error("separability questions must be an array");
  const seen = new Set();
  for (const [index, question] of value.entries()) {
    if (question === null || typeof question !== "object" || typeof question.question_id !== "string") {
      throw new Error(`questions[${index}].question_id is required`);
    }
    if (seen.has(question.question_id)) throw new Error(`duplicate question_id: ${question.question_id}`);
    seen.add(question.question_id);
  }
  return value;
}

function normalizeFoldCount(value) {
  if (!Number.isInteger(value) || value < 3) throw new Error("fold count must be an integer >= 3");
  return value;
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function find(parents, index) {
  if (parents[index] !== index) parents[index] = find(parents, parents[index]);
  return parents[index];
}

function union(parents, left, right) {
  const leftRoot = find(parents, left);
  const rightRoot = find(parents, right);
  if (leftRoot === rightRoot) return;
  if (leftRoot < rightRoot) parents[rightRoot] = leftRoot;
  else parents[leftRoot] = rightRoot;
}
