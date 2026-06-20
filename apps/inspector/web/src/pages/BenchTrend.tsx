import { useBenchTrendState } from "./bench-trend-state";
import { BenchTrendView } from "./bench-trend-view";

export default function BenchTrendPage() {
  return <BenchTrendView state={useBenchTrendState()} />;
}
