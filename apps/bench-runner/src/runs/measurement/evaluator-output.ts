import { AlayaError } from "@do-soul/alaya-protocol";
import { canonicalPath, canonicalPathsOverlap } from "../fs/opened-contained-path.js";

/** Bind all evaluator outputs to disjoint physical roots against the same admitted inputs. */
export function admitEvaluatorOutputRoots(evaluatorRoots: readonly string[], protectedPaths: readonly string[]): readonly string[] {
  const physicalRoots = evaluatorRoots.map(root => {
    if (!root) throw new AlayaError("VALIDATION", "gold measurement requires an evaluator root");
    return canonicalPath(root);
  });
  const physicalInputs = protectedPaths.map(canonicalPath);
  for (const [index, physicalRoot] of physicalRoots.entries()) {
    if (physicalInputs.some(path => canonicalPathsOverlap(physicalRoot, path)) ||
        physicalRoots.slice(0, index).some(path => canonicalPathsOverlap(physicalRoot, path))) {
      throw new AlayaError("VALIDATION", "gold measurement root must be separate from producer and input roots");
    }
  }
  return physicalRoots;
}

/** Bind one evaluator output to the same physical-input boundary. */
export function admitEvaluatorOutputRoot(evaluatorRoot: string, protectedPaths: readonly string[]): string {
  return admitEvaluatorOutputRoots([evaluatorRoot], protectedPaths)[0]!;
}
