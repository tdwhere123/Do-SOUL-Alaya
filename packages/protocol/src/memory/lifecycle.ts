import { z } from "zod";

const objectLifecycleStateValues = ["draft", "active", "dormant", "archived", "tombstone"] as const;

export const ObjectLifecycleState = {
  DRAFT: "draft",
  ACTIVE: "active",
  DORMANT: "dormant",
  ARCHIVED: "archived",
  TOMBSTONE: "tombstone"
} as const;

export const ObjectLifecycleStateSchema = z.enum(objectLifecycleStateValues);

export type ObjectLifecycleState = z.infer<typeof ObjectLifecycleStateSchema>;

const lifecycleTransitions: Readonly<Record<ObjectLifecycleState, readonly ObjectLifecycleState[]>> = {
  draft: ["active"],
  active: ["dormant", "archived", "tombstone"],
  dormant: ["active", "archived", "tombstone"],
  archived: ["tombstone"],
  tombstone: []
};

export function isValidLifecycleTransition(from: ObjectLifecycleState, to: ObjectLifecycleState): boolean {
  return lifecycleTransitions[from].includes(to);
}
