import type { WorkspaceLayoutPayload, WorkspaceWidgetPlacement } from "../api";

function clonePlacements(widgets: WorkspaceWidgetPlacement[]): WorkspaceWidgetPlacement[] {
  return widgets.map((widget) => ({ ...widget }));
}

export type LayoutEditorState = {
  layout: WorkspaceLayoutPayload;
  draft: WorkspaceWidgetPlacement[];
  editing: boolean;
  conflict: WorkspaceLayoutPayload | undefined;
};

export function applyRemoteLayout(
  state: LayoutEditorState,
  remote: WorkspaceLayoutPayload,
  replaceDraft: boolean,
): LayoutEditorState {
  if (!replaceDraft) {
    return { ...state, layout: remote };
  }
  return {
    layout: remote,
    draft: clonePlacements(remote.widgets),
    editing: false,
    conflict: undefined,
  };
}

export function keepDraftOnConflict(state: LayoutEditorState, remote: WorkspaceLayoutPayload): LayoutEditorState {
  return {
    ...state,
    conflict: remote,
  };
}

export function reloadFromConflict(state: LayoutEditorState): LayoutEditorState {
  if (!state.conflict) return state;
  return applyRemoteLayout(state, state.conflict, true);
}

export function versionForOverwrite(state: LayoutEditorState): number {
  return state.conflict?.version ?? state.layout.version;
}
