import { AlayaError } from "@do-soul/alaya-protocol";
import { canonicalPath, canonicalPathsOverlap } from "../fs/opened-contained-path.js";

/** Bind evaluator output to a physical root disjoint from every admitted producer and input path. */
export function admitEvaluatorOutputRoot(evaluatorRoot: string, protectedPaths: readonly string[]): string {
  if (!evaluatorRoot) throw new AlayaError("VALIDATION", "gold measurement requires an evaluator root");
  const physicalRoot = canonicalPath(evaluatorRoot);
  if (protectedPaths.some((path) => canonicalPathsOverlap(physicalRoot, canonicalPath(path)))) {
    throw new AlayaError("VALIDATION", "gold measurement root must be separate from producer and input roots");
  }
  return physicalRoot;
}
