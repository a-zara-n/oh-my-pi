import type { SessionEntry } from "@oh-my-pi/pi-utils/session-entries";
export * from "@oh-my-pi/pi-utils/session-entries";
/** Tree node for getTree() - defensive copy of session structure */
export interface SessionTreeNode {
	entry: SessionEntry;
	children: SessionTreeNode[];
	/** Resolved label for this entry, if any */
	label?: string;
}
