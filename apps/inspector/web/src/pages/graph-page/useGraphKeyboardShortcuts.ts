import { useEffect } from "react";
import type { GraphNode } from "../../types/graph";

export interface GraphKeyboardState {
  readonly matchCount: number;
  readonly searchTerm: string;
  readonly selectedNode: GraphNode | null;
  readonly spotlightActive: boolean;
}

export function useGraphKeyboardShortcuts(props: {
  readonly keyboardStateRef: React.MutableRefObject<GraphKeyboardState>;
  readonly searchInputRef: React.RefObject<HTMLInputElement>;
  readonly setMatchCursor: React.Dispatch<React.SetStateAction<number>>;
  readonly setSearchTerm: React.Dispatch<React.SetStateAction<string>>;
  readonly setSelectedNode: (node: GraphNode | null) => void;
}) {
  const { keyboardStateRef, searchInputRef, setMatchCursor, setSearchTerm, setSelectedNode } = props;
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const state = keyboardStateRef.current;
      const target = event.target as HTMLElement | null;
      const isTyping = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (shouldFocusSearch(event, isTyping)) {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === "Escape") {
        handleEscape(state, setSelectedNode, setSearchTerm);
      } else if (shouldMoveMatch(event, state, isTyping, target, searchInputRef.current)) {
        event.preventDefault();
        setMatchCursor((cursor) => nextCursor(cursor, state.matchCount, event.key));
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [keyboardStateRef, searchInputRef, setMatchCursor, setSearchTerm, setSelectedNode]);
}

function shouldFocusSearch(event: KeyboardEvent, isTyping: boolean): boolean {
  return (
    (event.key === "/" && !isTyping) ||
    (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))
  );
}

function shouldMoveMatch(
  event: KeyboardEvent,
  state: GraphKeyboardState,
  isTyping: boolean,
  target: HTMLElement | null,
  searchInput: HTMLInputElement | null
): boolean {
  return (
    (event.key === "ArrowDown" || event.key === "ArrowUp") &&
    state.spotlightActive &&
    state.matchCount > 0 &&
    isTyping &&
    target === searchInput
  );
}

function handleEscape(
  state: GraphKeyboardState,
  setSelectedNode: (node: GraphNode | null) => void,
  setSearchTerm: React.Dispatch<React.SetStateAction<string>>
) {
  if (state.selectedNode) setSelectedNode(null);
  else if (state.searchTerm) setSearchTerm("");
}

function nextCursor(cursor: number, matchCount: number, key: string): number {
  if (key === "ArrowDown") return (cursor + 1) % matchCount;
  return (cursor - 1 + matchCount) % matchCount;
}
